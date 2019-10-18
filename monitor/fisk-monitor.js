#!/usr/bin/env node

const option = require('@jhanssen/options')({ prefix: 'fisk/monitor',
                                              applicationPath: false,
                                              additionalFiles: [ "fisk/monitor.conf.override" ] });
const WebSocket = require('ws');
const fs = require('fs');
const blessed = require('blessed');
const humanizeDuration = require('humanize-duration');

const screen = blessed.screen({
    smartCSR: true
});

const slaveContainer = blessed.box({
    top: '0%',
    left: '0%',
    width: '50%',
    height: '100%-3',
    border: {
        type: 'line'
    }
});

screen.on("resize", () => {
    // log("resize", slaveContainer.width, slaveContainer.height);

    updateSlaveBox();
    updateClientBox();

    screen.render();
});

const slaveHeader = blessed.box({
    top: '0%',
    left: '0%',
    width: '100%-2',
    height: '0%+1',
    tags: true,
    style: {
        fg: 'white',
        bg: '#00ff00',
        border: {
            fg: '#f0f0f0'
        }
    }
});

var prompt = blessed.prompt({
    parent: screen,
    top: 'center',
    left: 'center',
    height: 'shrink',
    width: 'shrink',
    keys: true,
    style: {
        fg: "white"
    },
    vi: true,
    mouse: true,
    tags: true,
    border: 'line',
    hidden: true
});

const slaveBox = blessed.list({
    top: '0%+1',
    left: '0%',
    width: '100%-2',
    height: '100%-3',
    tags: true,
    scrollable: true,
    scrollbar: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {},
    search: callback => {
        prompt.input('Search:', '', (err, value) => {
            if (err)
                return;
            return callback(null, value);
        });
    }
});
slaveBox.headerBox = slaveHeader;

const clientContainer = blessed.box({
    top: '0%',
    left: '50%',
    width: '50%',
    height: '100%-3',
    border: {
        type: 'line'
    }
});

const clientHeader = blessed.box({
    top: '0%',
    left: '0%',
    width: '100%-2',
    height: '0%+1',
    tags: true,
    style: {
        fg: '#000000',
        bg: '#00ff00',
        border: {
            fg: '#f0f0f0'
        }
    }
});

const clientBox = blessed.list({
    top: '0%+1',
    left: '0%',
    width: '100%-2',
    height: '100%-3',
    tags: true,
    scrollable: true,
    scrollbar: true,
    mouse: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    style: {}
});
clientBox.headerBox = clientHeader;

const notificationBox = blessed.box({
    top: '100%-3',
    left: '0%',
    width: '100%',
    height: '0%+3',
    tags: true,
    border: {
        type: 'line'
    },
    style: {
        fg: 'white',
        bg: 'cyan',
        border: {
            fg: '#f0f0f0'
        }
    }
});

slaveContainer.append(slaveHeader);
slaveContainer.append(slaveBox);
clientContainer.append(clientHeader);
clientContainer.append(clientBox);
screen.append(slaveContainer);
screen.append(clientContainer);
screen.append(notificationBox);
let slaveDialogBox;

function hideDialogBoxes()
{
    let ret = false;
    if (slaveDialogBox) {
        slaveDialogBox.detach();
        slaveDialogBox = undefined;
        ret = true;
    }

    if (clientDialogBox) {
        clientDialogBox.detach();
        clientDialogBox = undefined;
        ret = true;
    }
    return ret;
}

slaveBox.on("select", ev => {
    let render = hideDialogBoxes();
    activate(slaveBox);
    if (ev) {
        let slaveKey = /^ *([^ ]*)/.exec(ev.content)[1];
        let slave = slaves.get(slaveKey);
        if (slave) {
            slaveBox.current = slaveKey;
            let str = "";
            for (let key in slave) {
                let value = slave[key];
                if (Array.isArray(value)) {
                    str += `{bold}${key}{/bold}: ${value[0]}\n`;
                    for (let i=1; i<value.length; ++i) {
                        let pad = "".padStart(key.length + 2, ' ');
                        str += pad + value[i].padStart(key.length + 2, ' ') + "\n";
                    }
                } else {
                    str += `{bold}${key}{/bold}: ${value}\n`;
                }
            }
            slaveDialogBox = blessed.box({
                top: 'center',
                left: 'center',
                width: '80%',
                height: '50%',
                content: str,
                tags: true,
                border: {
                    type: 'line'
                },
                style: {
                    fg: 'white',
                    bg: '#0f0f0f',
                    border: {
                        fg: '#f0f0f0'
                    }
                }
            });
            screen.append(slaveDialogBox);
            render = true;
        }
    }
    if (render)
        screen.render();
});

let clientDialogBox;
clientBox.on("select", ev => {
    let render = hideDialogBoxes();
    activate(clientBox);
    if (ev) {
        // log("got ev", Object.keys(ev), ev.index, ev.$, ev.data);
        let clientKey = /^ *([^ ]*)/.exec(ev.content)[1];
        let jobs = jobsForClient.get(clientKey);
        // let client = clients.get(clientKey);
        if (jobs) {
            clientBox.current = clientKey;
            let str = "";
            let data = [ [ "Source file", "Slave", "Start time" ] ];
            let widest = [ data[0][0].length + 1, data[0][1].length + 1 ];
            const now = Date.now();
            for (let [jobKey, jobValue] of jobs) {
                if (jobKey == "total")
                    continue;
                widest[0] = Math.max(jobValue.sourceFile.length + 1, widest[0]);
                data.push([ jobValue.sourceFile, jobValue.slave.ip + ":" + jobValue.slave.port, humanizeDuration(now - jobValue.time)]);
                widest[1] = Math.max(widest[1], data[data.length - 1][1].length + 1);
            }

            data.sort((a, b) => a[2] - b[2]);

            data.forEach((line, idx) => {
                if (!idx)
                    str += "{bold}";
                str += line[0].padEnd(widest[0]) + "  " + line[1].padEnd(widest[1]) + "  " + line[2] + " ago\n";
                if (!idx)
                    str += "{/bold}";
            });
            clientDialogBox = blessed.box({
                top: 'center',
                left: 'center',
                width: '80%',
                height: '50%',
                content: str,
                tags: true,
                border: {
                    type: 'line'
                },
                style: {
                    fg: 'white',
                    bg: '#0f0f0f',
                    border: {
                        fg: '#f0f0f0'
                    }
                }
            });
            screen.append(clientDialogBox);
            render = true;
        }
    }
    if (render)
        screen.render();
});

let currentFocus = undefined;
function activate(box)
{
    if (currentFocus == box)
        return;

    if (currentFocus) {
        currentFocus.style = {
            selected: {
                bg: '#606060',
                bold: true
            },
            item: {
                bg: '#404040'
            },
            fg: 'white',
            bg: '#404040',
            border: {
                fg: '#f0f0f0'
            },
            scrollbar: {
                bg: 'red',
                fg: 'blue'
            }
        };
        currentFocus.headerBox.style.fg = 'black';
    }

    currentFocus = box;
    currentFocus.style = {
        selected: {
            bg: 'blue',
            bold: true
        },
        item: {
            bg: "black"
        },
        fg: 'white',
        bg: 'black',
        border: {
            fg: '#f0f0f0'
        },
        scrollbar: {
            bg: 'red',
            fg: 'blue'
        }
    }
    currentFocus.headerBox.style.fg = 'white';
    currentFocus.focus();
    screen.render();
}

activate(clientBox);
activate(slaveBox);

function focusRight()
{
    if (currentFocus == slaveBox) {
        activate(clientBox);
    }
}

function focusLeft()
{
    if (currentFocus == clientBox) {
        activate(slaveBox);
    }
}

// Quit on Escape, q, or Control-C.
screen.key(['q', 'C-c'], (ch, key) => {
    return process.exit();
});
screen.key(['escape'], (ch, key) => {
    if (slaveDialogBox) {
        slaveDialogBox.detach();
        slaveDialogBox = undefined;
        screen.render();
    } else if (clientDialogBox) {
        clientDialogBox.detach();
        clientDialogBox = undefined;
        screen.render();
    } else {
        process.exit();
    }
});
screen.key(['right', 'l'], (ch, key) => {
    focusRight();
});
screen.key(['left', 'h'], (ch, key) => {
    focusLeft();
});

slaveBox.on('click', () => {
    activate(slaveBox);
});
clientBox.on('click', () => {
    activate(clientBox);
});

screen.render();

let notificationInterval;
let notifications = [];

function notify(msg)
{
    if (notificationInterval) {
        if (notifications.length == 5)
            notifications.splice(0, 1);
        notifications.push(msg);
        return;
    }

    const notifyNow = msg => {
        notificationBox.setContent(msg);
        screen.render();
    };

    notificationInterval = setInterval(() => {
        if (notifications.length == 0) {
            clearInterval(notificationInterval);
            notificationInterval = undefined;
            notifyNow();
            return;
        }

        notifyNow(notifications.shift());
    }, 2000);

    notifyNow(msg);
}

let scheduler = option("scheduler", "ws://localhost:8097");
if (scheduler.indexOf('://') == -1)
    scheduler = "ws://" + scheduler;
if (!/:[0-9]+$/.exec(scheduler))
    scheduler += ":8097";

function log(...args)
{
    const str = args.map(elem => typeof elem === "object" ? JSON.stringify(elem) : elem).join(" ");
    fs.appendFileSync("/tmp/fisk-monitor.log", str + "\n");
}

try {
    // fs.unlinkSync("/tmp/fisk-monitor.log");
} catch (e) {
}

const slaves = new Map();
const jobs = new Map();
const jobsForClient = new Map();

function clearData()
{
    slaves.clear();
    jobs.clear();
    jobsForClient.clear();

    update();
}

function formatCell(str, num, prefix, suffix)
{
    return (prefix || "") + (" " + str).padEnd(num, " ").substr(0, num) + (suffix || "");
}

let updateTimer;
let timeout = 0;

function updateSlaveBox()
{
    const slaveWidth = slaveContainer.width - 3;

    let data = [];
    let maxWidth = [6, 8, 7, 7];
    for (let [key, value] of slaves) {
        const line = [key, `${value.active}`, `${value.jobsPerformed}`, `${value.slots}`];
        data.push(line);

        maxWidth[0] = Math.max(maxWidth[0], line[0].length + 2);
        maxWidth[1] = Math.max(maxWidth[1], line[1].length + 2);
        maxWidth[2] = Math.max(maxWidth[2], line[2].length + 2);
        maxWidth[3] = Math.max(maxWidth[3], line[3].length + 2);
    }
    data.sort((a, b) => {
        let an = parseInt(a[1]);
        let bn = parseInt(b[1]);
        if (an != bn)
            return bn - an;
        an = parseInt(a[2]);
        bn = parseInt(b[2]);
        if (an != bn)
            return bn - an;
        return a[0].localeCompare(b[0]);
    });

    let used = 0;
    for (let i = 0; i < maxWidth.length; ++i) {
        if (used + maxWidth[i] > slaveWidth)
            maxWidth[i] = slaveWidth - used;
        used += maxWidth[i];
    }
    let header = "";
    header += formatCell("Host", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Active", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    header += formatCell("Slots", maxWidth[3], "{bold}", "{/bold}");
    slaveHeader.setContent(header);

    let item = slaveBox.getItem(slaveBox.selected);
    let selectedSlave;
    if (item) {
        selectedSlave = /^ *([^ ]*)/.exec(item.content)[1];
    }
    let current;
    let items = data.map((item, idx) => {
        if (item[0] == selectedSlave) {
            current = idx;
        }
        return formatCell(item[0], maxWidth[0]) + formatCell(item[1], maxWidth[1]) + formatCell(item[2], maxWidth[2]) + formatCell(item[3], maxWidth[3]);
    });
    slaveBox.setItems(items);
    if (current != undefined) {
        slaveBox.selected = current;
    }
}

function updateClientBox()
{
    const clientWidth = clientContainer.width - 3;

    let data = [];
    let maxWidth = [6, 6, 7];
    for (let [key, value] of jobsForClient) {
        const line = [key, `${value.size - 1}`, `${value.get("total")}`];
        data.push(line);

        maxWidth[0] = Math.max(maxWidth[0], line[0].length + 2);
        maxWidth[1] = Math.max(maxWidth[1], line[1].length + 2);
        maxWidth[2] = Math.max(maxWidth[2], line[2].length + 2);
    }

    data.sort((a, b) => a[0].localeCompare(b[0]));

    let used = 0;
    for (let i of [1, 2, 0]) {
        if (used + maxWidth[i] > clientWidth)
            maxWidth[i] = clientWidth - used;
        used += maxWidth[i];
    }

    let header = "";
    header += formatCell("Name", maxWidth[0], "{bold}", "{/bold}");
    header += formatCell("Jobs", maxWidth[1], "{bold}", "{/bold}");
    header += formatCell("Total", maxWidth[2], "{bold}", "{/bold}");
    clientHeader.setContent(header);

    let item = clientBox.getItem(clientBox.selected);
    let selectedClient;
    if (item) {
        selectedClient = /^ *([^ ]*)/.exec(item.content)[1];
    }
    let current;
    let items = data.map((item, idx) => {
        if (item[0] == selectedClient) {
            current = idx;
        }
        return formatCell(item[0], maxWidth[0]) + formatCell(item[1], maxWidth[1]) + formatCell(item[2], maxWidth[2]);
    });

    clientBox.setItems(items);
    if (current != undefined) {
        clientBox.selected = current;
    }
}

function update()
{
    //let data = [];
    if (updateTimer)
        return;
    updateTimer = setTimeout(() => {
        updateTimer = undefined;
        timeout = 500;

        updateSlaveBox();
        updateClientBox();

        screen.render();
    }, timeout);
}

function slaveAdded(msg)
{
    msg.active = 0;
    delete msg.type;
    slaves.set(msg.ip + ":" + msg.port, msg);
    update();
}

function slaveRemoved(msg)
{
    const slaveKey = msg.ip + ":" + msg.port;

    for (let [jobKey, jobValue] of jobs) {
        if (jobValue.slave) {
            const jobSlaveKey = `${jobValue.slave.ip}:${jobValue.slave.port}`;
            if (slaveKey === jobSlaveKey) {
                deleteJob(jobValue);
            }
        }
    }

    slaves.delete(slaveKey);
    update();
}

function clientName(client)
{
    if ("name" in client) {
        if (client.name === client.hostname) {
            return "dev:" + (client.user || "nobody") + "@" + client.hostname;
        } else if (client.name.length > 0 && client.name[0] === '-') {
            return "dev:" + (client.user || "nobody") + client.name;
        }
        try {
            const o = JSON.parse(client.name);
            if (typeof o === "object" && "name" in o)
                return o.name;
        } catch (e) {
        }
        return client.name;
    }
    return client.ip;
}

function jobStarted(job)
{
    // log(job);
    const slaveKey = `${job.slave.ip}:${job.slave.port}`;
    const slave = slaves.get(slaveKey);
    if (!slave)
        return;

    const clientKey = clientName(job.client);
    let client = jobsForClient.get(clientKey);
    job.time = Date.now();
    // log("got job started", clientKey);
    if (!client) {
        client = new Map([["total", 1]]);
        jobsForClient.set(clientKey, client);
    } else {
        client.set("total", client.get("total") + 1);
    }
    delete job.type;
    client.set(job.id, job);

    jobs.set(job.id, job);
    ++slave.jobsPerformed;
    ++slave.active;
    update();
}

function deleteJob(job)
{
    const clientKey = clientName(job.client);
    let client = jobsForClient.get(clientKey);
    if (client) {
        client.delete(job.id);
        if (client.size == 1) {
            jobsForClient.delete(clientKey);
        }
    }
}

function jobFinished(job)
{
    const activejob = jobs.get(job.id);
    if (!activejob)
        return;
    jobs.delete(job.id);

    deleteJob(activejob);

    const key = `${activejob.slave.ip}:${activejob.slave.port}`;
    const slave = slaves.get(key);
    if (!slave)
        return;
    --slave.active;
    update();
}

let ws;

function send(msg)
{
    if (typeof msg != "string") {
        ws.send(JSON.stringify(msg));
    } else {
        ws.send(msg);
    }
}

function connect()
{
    const url = `${scheduler}/monitor`;
    notify(`connect ${url}`);
    ws = new WebSocket(url);
    ws.on("open", () => {
        notify("open");
        send({ type: "sendInfo" });
    });
    ws.on("error", err => {
        notify(`client websocket error ${err.message}`);
    });
    ws.on("message", msg => {
        //notify(`msg ${msg}`);
        let obj;
        try {
            obj = JSON.parse(msg);
        } catch (e) {
            notify(`msg parse error: ${msg}, ${e}`);
        }
        switch (obj.type) {
        case "slaveAdded":
            slaveAdded(obj);
            break;
        case "slaveRemoved":
            slaveRemoved(obj);
            break;
        case "jobStarted":
            jobStarted(obj);
            break;
        case "jobFinished":
        case "jobAborted":
            jobFinished(obj);
            break;
        default:
            //log(obj);
            break;
        }
    });
    ws.on("close", () => {
        clearData();
        setTimeout(connect, 1000);
    });
}

connect();
