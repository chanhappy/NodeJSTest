const http = require('http');
const agent1 = new http.Agent({
    keepAlive: true,
    // maxSockets: 3
});

var message = {
    "data": "hello server"
}

let requests = [];

function test() {
    let headers = {};
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(message));
    headers['Content-Type'] = "application/json";
    let options = {
        hostname: '127.0.0.1',
        port: 53009,
        path: '/',
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

for (let index = 0; index < 2; index++) {
    requests.push(test())
}

Promise.all(requests).then((result) => {
    console.log("all requests done!")
}).catch((err) => {
    console.error("err:" + err)
})






