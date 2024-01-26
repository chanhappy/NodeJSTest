var fs = require("fs");
var iconv = require("iconv-lite");

var filePath = "./test.txt";
let content_buffer = iconv.encode(JSON.stringify("你好a"), 'utf-8')
fs.writeFile(filePath, content_buffer, (err) => {
    console.log("writeFile err:", err);
})

setTimeout(() => {
    fs.copyFile("./test.txt", "./target.txt", (err) => {
        console.log("copyFile err:", err);
    });
}, 1000); // 1000 毫秒后执行回调函数




