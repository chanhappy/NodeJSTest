const { MultiFormatReader, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = require("@zxing/library")
const fs = require("fs")
const jpeg = require('jpeg-js');

function getPosition(cutTimes, width, height) {
    if (cutTimes != 0) {
        let position = [];
        let cutRatio = cutTimes + 1;
        for (let i = 0; i < cutRatio; i++) {
            for (let j = 0; j < cutRatio; j++) {
                const pos = {};
                pos["swidth"] = width / cutRatio;
                pos["sheight"] = height / cutRatio;
                pos["left"] = i * pos["swidth"];
                pos["top"] = j * pos["sheight"];
                position.push(pos);
            }
        }
        return position;
    }
    else {
        return [{ swidth: width, sheight: height, left: 0, top: 0 }];
    }
}

function decode(rawImageData, position) {
    try {
        const qc = new MultiFormatReader()
        const len = rawImageData.width * rawImageData.height;
        const luminancesUint8Array = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            luminancesUint8Array[i] = ((rawImageData.data[i * 4] + rawImageData.data[i * 4 + 1] * 2 + rawImageData.data[i * 4 + 2]) / 4) & 0xFF;
        }
        const luminanceSource = new RGBLuminanceSource(luminancesUint8Array, parseInt(position.swidth), parseInt(position.sheight), rawImageData.width, rawImageData.height, parseInt(position.left), parseInt(position.top));
        const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));
        let result = qc.decode(binaryBitmap).text
        return result;
    } catch (err) {
        return { Error: err };
    }
}

function readQRCodeAsync(path, times) {
    let result = { IsSuccess: false, Content: [] };
    const errorData = [];
    try {
        const jpegData = fs.readFileSync(path)
        const rawImageData = jpeg.decode(jpegData);
        for (let k = 0; k <= times; k++) {
            if (result.Content.length == 0) {
                let position = getPosition(k, rawImageData.width, rawImageData.height);
                console.log("k:", k, "position:", position);
                for (let i = 0; i < position.length; i++) {
                    let contect = decode(rawImageData, position[i])
                    if (!contect.Error) {
                        result.Content.push(contect);
                        result.IsSuccess = true;
                    } else {
                        errorData.push(contect.Error);
                    }
                }
            }
        }
    } catch (err) {
        result.Content.push(err);
        result.Content.push(errorData);
    }
    return result;
}


let qrCodeResult = readQRCodeAsync("./nihao.png", 1)
console.log("qrCodeResult:", qrCodeResult);