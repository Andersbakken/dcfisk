#!/usr/bin/env node

const fs = require('fs');
const child_process = require('child_process');
const WebSocket = require('ws');
const os = require('os');
const path = require('path');

const argv = require('minimist')(process.argv.slice(2));
const silent = argv.silent;
let tarball;
let scheduler;

if (!argv.scheduler || !argv.hash || !argv.compiler || !argv.system) {
    console.log(argv);
    if (!silent) {
        console.error("Bad args, need --scheduler, --hash, --system and --compiler");
    }
    process.exit(1);
}
if (!/\/$/.exec(argv.scheduler)) {
    scheduler = argv.scheduler + '/';
} else {
    scheduler = argv.scheduler;
}

function die()
{
    if (!silent) {
        console.error.apply(console, arguments);
    }
    if (tarball) {
        try {
            fs.unlinkSync(tarball);
        } catch (err) {

        }
    }
    process.exit(1);
}

let createEnvProc;
process.on('SIGINT', () => { process.exit(); });

process.on('exit', () => {
    if (!silent)
        console.log("exit", typeof createEnvProc);
    if (createEnvProc)
        createEnvProc.kill(9);
});

function makeTarball()
{
    return new Promise((resolve, reject) => {
        let dashV = child_process.spawn(argv.compiler, [ "-v" ]);
        let dashVOut = "";

        dashV.stdout.on('data', (data) => { dashVOut += data; });
        dashV.stderr.on('data', (data) => { dashVOut += data; });

        dashV.on('close', () => {
            let out = "";
            let err = "";

            const cwd = os.tmpdir();
            const info = path.join(cwd, "compiler-info_" + argv.hash);
            fs.writeFileSync(info, dashVOut);
            createEnvProc = child_process.spawn("bash", [ `${__dirname}/icecc-create-env`, argv.compiler, "--addfile", info + ":/etc/compiler_info" ], { cwd: cwd });
            createEnvProc.stdout.on('data', (data) => { out += data; });
            createEnvProc.stderr.on('data', (data) => { err += data; });
            createEnvProc.on('close', (code) => {
                if (!code) {
                    let lines = out.split('\n').filter(x => x);
                    if (!silent) {
                        console.log("output:\n" + out);
                    }

                    let line = lines[lines.length - 1];
                    tarball = line.split(" ")[1];
                    if (!silent)
                        console.log("got tarball", tarball);
                    resolve(path.join(cwd, tarball));
                } else {
                    die(`icecc-create-env exited with code: ${code}\n${err}`);
                }
                if (!silent)
                    console.log(`child process exited with code ${code}`);
            });
        });
    });
}

function connectWs()
{
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(argv.scheduler,
                                 [],
                                 {
                                     'headers': {
                                         'x-fisk-hash': argv.hash
                                     }
                                 });


        ws.on('open', () => {
            resolve(ws);
        });

        ws.on('message', data => {
            if (!silent)
                console.log("Got message from scheduler", data);
        });
        ws.on('error', err => {
            if (!silent)
                console.error("Got error", err.message, err.stack);
        });
        ws.on('close', () => {
            process.exit();
        });
    });
}

Promise.all([ makeTarball(), connectWs() ]).then((data) => {
    let ws = data[1];
    let size;
    try {
        size = fs.statSync(data[0]).size;
    } catch (err) {
        die("Got error ", data[0], err.message, err.stack);
    }
    // console.log("Got data", data, size);
    let f = fs.openSync(data[0], "r");
    if (!f) {
        die(`Failed to open file ${data[0]} for reading`);
    }

    ws.send(JSON.stringify({ hash: argv.hash, bytes: size, system: argv.system }));
    if (!silent)
        console.log("sent text message", size);
    const chunkSize = 64 * 1024;
    let sent = 0;
    for (let i=0; i<size; i += chunkSize) {
        let s = Math.min(size - i, chunkSize);
        let buf = Buffer.allocUnsafe(s);
        if (fs.readSync(f, buf, 0, s) != s) {
            die("Failed to read bytes from enviroment");
        }
        sent += s;
        ws.send(buf);
    }
    if (!silent)
        console.log(`sent ${sent} bytes`);
    if (!argv["keep-tarball"])
        fs.unlinkSync(data[0]);
}).catch((err) => {
    die(err);
});