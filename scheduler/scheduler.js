#!/usr/bin/env node

const path = require("path");
const os = require("os");
const option = require("@jhanssen/options")("fisk-scheduler");
const Server = require("./src/server");
const Environments = require("./src/environments");
const server = new Server(option);

const slaves = {};

server.on("slave", function(slave, environments) {
    console.log("slave connected", slave.ip, environments);
    slaves[slave.ip] = { client: slave, environments: environments };
    Environments.environments.forEach((k) => {
        if (environments.indexOf(k.hash) === -1) {
            console.log("sending", k.hash, "to", slave.ip);
            k.send(slave);
        }
    });

    slave.on("load", function(load) {
        // console.log("slave load", load);
        slaves[slave.ip].load = load.message;
    });
    slave.on("error", function(msg) {
        console.error(`slave error '${msg}' from ${slave.ip}`);
    });
    slave.on("close", function() {
        delete slaves[slave.ip];
        slave.removeAllListeners();
    });

});

server.on("compile", function(compile) {
    let file;
    compile.on("job", function(request) {
        console.log("request", request.environment);
        if (!Environments.hasEnvironment(request.environment)) {
            compile.send({ type: "needsEnvironment" });
            return;
        }

        let best = { load: Infinity };
        for (let ip in slaves) {
            let slave = slaves[ip];
            console.log("GOT SLAVE", slave);
            if ("load" in slave /* && "environments" in slave*/) {
                if (/*slave.environments.indexOf(request.environment) !== -1 &&*/ slave.load < best.load) {
                    best.load = slave.load;
                    best.ip = ip;
                    best.slavePort = slave.client.slavePort;
                }
            }
        }
        console.log("best", best);
        if (best.load < Infinity) {
            compile.send("slave", { ip: best.ip, port: best.slavePort });
        } else {
            compile.send("slave", {});
        }
    });
    compile.on("error", function(msg) {
        console.error(`compile error '${msg}' from ${compile.ip}`);
    });
    compile.on("close", function() {
        compile.removeAllListeners();
    });
});

server.on("uploadEnvironment", function(upload) {
    let file;
    upload.on("environment", function(environment) {
        file = Environments.prepare(environment);
        console.log("Got environment message", environment, typeof file);
        if (!file) {
            // we already have this environment
            console.error("already got environment", environment.message);
            upload.send({ error: "already got environment" });
            upload.close();
        }
    });
    upload.on("environmentdata", function(environment) {
        if (!file) {
            console.error("no pending file");
            upload.send({ error: "no pending file" });
            upload.close();
        }
        console.log("Got environmentdata message", environment.data.length, environment.last);
        file.save(environment.data).then(() => {
            if (environment.last) {
                file.close();
                upload.close();
                Environments.complete(file);
                file = undefined;
                // send any new environments to slaves
                for (var ip in slaves) {
                    let slave = slaves[ip];
                    for (var ek in Environments.environments) {
                        if (slave.environments && slave.environments.indexOf(ek) === -1) {
                            Environments.environments[ek].send(slave.client);
                        }
                    }
                }
            }
        }).catch(err => {
            console.log("file error", err);
            file = undefined;
        });
    });
    upload.on("error", function(msg) {
        console.error(`upload error '${msg}' from ${upload.ip}`);
        if (file) {
            file.discard();
            file = undefined;
        }
    });
    upload.on("close", function() {
        upload.removeAllListeners();
        if (file) {
            file.discard();
            file = undefined;
        }
    });
});

server.on("error", function(err) {
    console.error(`error '${err.message}' from ${err.ip}`);
});

Environments.load(option("env-dir", path.join(os.homedir(), ".cache", "fisk", "scheduler", "environments"))).then(() => {
    server.listen();
}).catch(e => {
    console.error(e);
    process.exit();
});
