const EventEmitter = require("events");
const WebSocket = require("ws");
const Url = require("url");
const http = require("http");
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const slowdown = require('express-slow-down');

class Client extends EventEmitter {
    constructor(obj) {
        super();
        for (let key in obj)
            this[key] = obj[key];
        this.created = new Date();
    }

    send(type, msg) {
        try {
            if (msg === undefined) {
                if (type instanceof Buffer) {
                    this.ws.send(type);
                } else {
                    this.ws.send(JSON.stringify(type));
                }
            } else {
                let tosend;
                if (typeof msg === "object") {
                    tosend = msg;
                    tosend.type = type;
                } else {
                    tosend = { type: type, message: msg };
                }
                this.ws.send(JSON.stringify(tosend));
            }
        } catch (err) {

        }
    }

    close() {
        this.ws.close();
    }
};

Client.Type = {
    Slave: 0,
    Compile: 1,
    UploadEnvironment: 2,
    Monitor: 3
};

class Server extends EventEmitter {
    constructor(option, configVersion) {
        super();
        this.option = option;
        this.configVersion = configVersion;
        this.id = 0;
        this.nonces = {};
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.app = express();
            this.app.use(express.static(`${__dirname}/../ui/dist/ui`));
            const speedLimiter = slowdown({
                windowMs: 10000, // 10s
                delayAfter: 500, // allow 500 requests per 10 seconds
                delayMs: 500 // begin adding 500ms of delay per request
            });

            this.app.use(speedLimiter);
            this.emit("listen", this.app);

            this.app.all('/*', function(req, res, next) {
                // Just send the index.html for other files to support HTML5Mode
                res.sendFile('/index.html', { root: path.join(__dirname, "..", "ui", "dist", "ui") });
            });

            this.server = http.createServer(this.app);
            const port = this.option.int("port", 8097);
            this.server.listen({port: port, backlog: this.option.int("backlog", 50), host: "0.0.0.0"});

            this.server.on("error", error => {
                if (error.code == "EADDRINUSE") {
                    console.log(`Port ${port} is in use...`);
                    setTimeout(() => {
                        this.server.listen({ port: port, backlog: this.option.int("backlog", 50), host: "0.0.0.0"});
                    }, 1000);
                } else {
                    console.error("Got server error", error.toString());
                    this.emit("error", error);
                }
            });
            this.server.once("listening", () => {
                this.ws = new WebSocket.Server({ server: this.server });
                console.log("listening on", port);
                this.ws.on('headers', (headers, request) => {
                    const url = Url.parse(request.url);
                    headers.push("x-fisk-objectcache: " + (this.option.int("object-cache-size") > 0 ? "true" : "false"));
                    if (url.pathname == "/monitor") {
                        const nonce = crypto.randomBytes(256).toString("base64");
                        headers.push(`x-fisk-nonce: ${nonce}`);
                        request.nonce = nonce;
                    }
                });
                this.ws.on("connection", this._handleConnection.bind(this));
                resolve();
            });
        });
    }

    get express() { return this.app; }

    _handleConnection(ws, req) {
        let client = undefined;
        let ip = req.connection.remoteAddress;
        // console.log("_handleConnection", ip);

        const error = msg => {
            try {
                ws.send(`{"error": "${msg}"}`);
                ws.close();
                if (client) {
                    client.emit("error", msg);
                } else {
                    this.emit("error", { ip: ip, message: msg });
                }
            } catch (err) {
            }
        };

        if (!ip) {
            error("No ip for some reason");
            return;
        }
        if (ip.substr(0, 7) == "::ffff:") {
            ip = ip.substr(7);
        }

        const url = Url.parse(req.url);
        switch (url.pathname) {
        case "/compile": {
            // look at headers
            if (!("x-fisk-environments" in req.headers)) {
                error("No x-fisk-environments header");
                return;
            }

            const configVersion = req.headers["x-fisk-config-version"];
            if (configVersion != this.configVersion) {
                error(`Bad config version, expected ${this.configVersion}, got ${configVersion}`);
                return;
            }
            const compileEnvironment = req.headers["x-fisk-environments"];

            let data = {
                ws: ws,
                ip: ip,
                type: Client.Type.Compile,
                environment: compileEnvironment,
                sourceFile: req.headers["x-fisk-sourcefile"],
                md5: req.headers["x-fisk-md5"]
            };

            if (data.md5 && data.md5.length != 32) {
                error(`Bad md5 sum: ${data.md5}`);
                return;
            }
            const npmVersion = req.headers["x-fisk-npm-version"];
            if (npmVersion)
                data.npmVersion = npmVersion;
            const preferredSlave = req.headers["x-fisk-slave"];
            if (preferredSlave)
                data.slave = preferredSlave;
            const clientName = req.headers["x-fisk-client-name"];
            if (clientName)
                data.name = clientName;
            const user = req.headers["x-fisk-user"];
            if (user)
                data.user = user;
            const clientHostname = req.headers["x-fisk-client-hostname"];
            if (clientHostname)
                data.hostname = clientHostname;
            client = new Client(data);
            this.emit("compile", client);
            let remaining = { bytes: undefined, type: undefined };
            ws.on('close', (status, reason) => client.emit('close', status, reason));
            ws.on('error', err => client.emit('error', err));
            ws.on("close", (code, reason) => {
                if (remaining.bytes)
                    client.emit("error", "Got close while reading a binary message");
                if (client)
                    client.emit("close", { code: code, reason: reason });
                ws.removeAllListeners();
            });

            ws.on("message", msg => {
                switch (typeof msg) {
                case "string":
                    if (remaining.bytes) {
                        // bad, client have to send all the data in a binary message before sending JSON
                        error(`Got JSON message while ${remaining.bytes} bytes remained of a binary message`);
                        return;
                    }
                    // assume JSON
                    let json;
                    try {
                        json = JSON.parse(msg);
                    } catch (e) {
                    }
                    if (json === undefined) {
                        error("Unable to parse string message as JSON");
                        return;
                    }

                    if (json.type == 'log') {
                        client.emit("log", json);
                        return;
                    }
                    if (json.type != "uploadEnvironment") {
                        error("Expected type: \"uploadEnvironment\"");
                        return;
                    }

                    if (!("system" in json)) {
                        console.log(json);
                        error("Need a systen property");
                        return;
                    }
                    if (!("hash" in json)) {
                        console.log(json);
                        error("Need a hash property");
                        return;
                    }
                    if (!("bytes" in json)) {
                        console.log(json);
                        error("Need a bytes property");
                        return;
                    }

                    if (!("originalPath" in json)) {
                        console.log(json);
                        error("Need an originalPath property");
                        return;
                    }

                    remaining.type = "uploadEnvironmentData";
                    remaining.bytes = json.bytes;

                    client.emit("uploadEnvironment", json);
                    break;
                case "object":
                    if (msg instanceof Buffer) {
                        if (!msg.length) {
                            // no data?
                            error("No data in buffer");
                            return;
                        }
                        if (!remaining.bytes) {
                            error("Got binary message without a preceeding json message describing the data");
                            return;
                        }
                        if (msg.length > remaining.bytes) {
                            // woops
                            error(`length ${msg.length} > ${remaining.bytes}`);
                            return;
                        }
                        remaining.bytes -= msg.length;
                        client.emit(remaining.type, { data: msg, last: !remaining.bytes });
                    }
                    break;
                }
            });
            break; }
        case "/slave": {
            ws.on("close", (code, reason) => {
                if (client)
                    client.emit("close", { code: code, reason: reason });
                ws.removeAllListeners();
            });

            if (!("x-fisk-port" in req.headers)) {
                error("No x-fisk-port header");
                return;
            }

            if (!("x-fisk-environments" in req.headers)) {
                error("No x-fisk-slave-environment header");
                return;
            }

            if (!("x-fisk-slots" in req.headers) || !parseInt(req.headers["x-fisk-slots"])) {
                error("No x-fisk-slots header");
                return;
            }

            const confVersion = req.headers["x-fisk-config-version"];
            if (confVersion != this.configVersion) {
                error(`Bad config version, expected ${this.configVersion}, got ${confVersion}`);
                return;
            }

            const port = parseInt(req.headers["x-fisk-port"]);
            const name = req.headers["x-fisk-slave-name"];
            const hostname = req.headers["x-fisk-slave-hostname"];
            const system = req.headers["x-fisk-system"];
            const slots = parseInt(req.headers["x-fisk-slots"]);
            const npmVersion = req.headers["x-fisk-npm-version"];
            let environments = {};
            req.headers["x-fisk-environments"].replace(/\s+/g, '').split(';').forEach(env => {
                if (env)
                    environments[env] = true;
            });
            client = new Client({ ws: ws,
                                  ip: ip,
                                  port: port,
                                  type: Client.Type.Slave,
                                  name: name,
                                  slots: slots,
                                  jobsPerformed: 0,
                                  jobsScheduled: 0,
                                  totalCompileSpeed: 0,
                                  totalUploadSpeed: 0,
                                  lastJob: 0,
                                  load: 0,
                                  npmVersion: npmVersion,
                                  hostname: hostname,
                                  environments: environments,
                                  system: system });
            ws.on("message", msg => {
                // console.log("Got message from slave", typeof msg, msg.length);
                switch (typeof msg) {
                case "string":
                    // assume JSON
                    let json;
                    try {
                        json = JSON.parse(msg);
                    } catch (e) {
                    }

                    if (json === undefined) {
                        error("Unable to parse string message as JSON");
                        return;
                    }
                    // console.log("GOT MESSAGE", json);
                    if ("type" in json) {
                        client.emit(json.type, json);
                    } else {
                        console.error("Bad message without type", json);
                    }
                case "object":
                    if (msg instanceof Buffer) {
                        client.emit("data", msg);
                    }
                    break;
                }
            });
            // console.log("Got dude", envs);
            this.emit("slave", client);
            break; }
        case "/monitor":
            client = new Client({ ws: ws, ip: ip, type: Client.Type.Monitor});
            client.nonce = req.nonce;
            // console.log("Got nonce", req.nonce);
            ws.on("message", message => client.emit("message", message));
            this.emit("monitor", client);
            ws.on('close', (code, reason) => {
                ws.removeAllListeners();
                client.emit('close', { code: code, reason: reason });
            });

            ws.on('error', err => client.emit('error', err));
            break;
        default:
            error(`Invalid pathname ${url.pathname}`);
            return;
        }
    }
}

module.exports = Server;
