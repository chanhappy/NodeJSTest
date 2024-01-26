const path = require('path')
const fs = require('fs')

var source = path.join(__dirname, '../test');
var target = path.join(__dirname, '../dist');
copyAll(source, target);

function copyAll(src, dst) {
    var fileInfo = fs.statSync(src);
    if (fileInfo.isDirectory()) {
        if (!fs.existsSync(dst)) {
            fs.mkdirSync(dst);
        }
        let subPaths = fs.readdirSync(src);
        for (let i = 0; i < subPaths.length; i++) {
            const subPath = path.join(src, subPaths[i]);
            const subDst = path.join(dst, subPaths[i]);
            copyAll(subPath, subDst);
        }
    } else {

        fs.copyFileSync(src, dst);
    }
}
