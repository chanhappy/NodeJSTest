import { launch } from 'chrome-launcher';
const CDP = require('chrome-remote-interface');


async function main() {
    const chrome = await launch({
        startingUrl: "D:/0000000/NodeJSTest/Chrome DevTools Protoco测试demo/test.html",
        chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe"
    });
    console.log("端口号：", chrome.port);
    const { Runtime } = await CDP({ port: chrome.port });
    Runtime.enable()

    Runtime.consoleAPICalled((args) => {
        console.log("consoleAPICalled:", JSON.stringify(args));
    });

    Runtime.exceptionThrown((args) => {
        console.log("exceptionThrown:", JSON.stringify(args));
    })
}

main();