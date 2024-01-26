const cp = require('child_process')
const path = require('path');

function getUniqueIdAsync(exePath) {
    return new Promise((resolve, reject) => {
        const process = cp.spawn(exePath, [true, true], {
            windowsHide: true,
        })
        let reponseData = '';
        process.stdout.on("data", data => {
            reponseData += data;
        })
        process.on("error", err => {
            reject(err);
        })
        process.on("close", () => {
            resolve(reponseData)
        })
    })
}

async function test() {
    console.log("process.cwd():", __dirname);
    const exePath = path.resolve(process.cwd(), './UniqueId/GetUniqueId.exe')
    let uid = await getUniqueIdAsync(exePath);
    console.log(uid);
}

(async () => {
    await test();
})();

