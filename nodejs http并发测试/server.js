var http = require('http');
var iconv = require('iconv-lite');

http.createServer(function (request, response) {
    let resolveDataBuffer = Buffer.alloc(0);
    let resolveData = ""
    request.on("data", (data)=>{
        if(Buffer.isBuffer(data)){
            resolveDataBuffer = Buffer.concat([resolveDataBuffer, data], resolveDataBuffer.length + data.length);
        }
    })

    request.on("end", ()=>{
        if(resolveDataBuffer.length > 0){
            resolveData = iconv.decode(resolveDataBuffer, "utf-8");
        }
        console.log("receive client message: ", resolveData)
    })
    // response.writeHead(200, { 'Content-Type': 'text/plain' });
    // response.end('hello client');
}).listen(53009);