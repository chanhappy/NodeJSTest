const http = require('http');
const agent1 = new http.Agent({
    keepAlive: false
});

var message = {
    "data": "hello server"
}

function test() {
    let headers = {};
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(message));
    headers['Content-Type'] = "application/json";
    let options = {
        hostname: '192.168.71.86',
        port: 8008,
        path: '/test',
        method: 'POST',
        headers: headers,
        agent: agent1
    };
    const req = http.request(options, (res) => {
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on("error", error => {
            console.error("error:" + error);
        });
        req.on('timeout', function () {
            console.log("req timeout");
        })
        res.on('end', () => {
            console.log("receive from server data:" + data);
        });
    });
    let data = '';

    req.write(JSON.stringify(message))
    req.end();
}

test();
