const { MultiFormatReader, DecodeHintType, RGBLuminanceSource, BinaryBitmap, HybridBinarizer } = require("@zxing/library")
const fs = require("fs")
const jpeg = require('jpeg-js');


const qc = new MultiFormatReader()
const hints = new Map()

hints.set(DecodeHintType.CHARACTER_SET, 'utf-8')
hints.set(DecodeHintType.TRY_HARDER, '3')

qc.setHints(hints)

const jpegData = fs.readFileSync("./5.jpg")
const rawImageData = jpeg.decode(jpegData);

const len = rawImageData.width * rawImageData.height;

const luminancesUint8Array = new Uint8Array(len);

for (let i = 0; i < len; i++) {
	luminancesUint8Array[i] = ((rawImageData.data[i * 4] + rawImageData.data[i * 4 + 1] * 2 + rawImageData.data[i * 4 + 2]) / 4) & 0xFF;
}

console.log(rawImageData);
//width:二维码宽度
const width = 828;
//height:二维码高度
const height = 1171.5;
//left:二维码左边距
const left = 828;
//top:二维码上边距
const top = 0;
console.log(rawImageData);
// const luminanceSource = new RGBLuminanceSource(luminancesUint8Array, width, height, rawImageData.width, rawImageData.height, left, top);
// swidth: 828.5, sheight: 1170, left: 0, top: 0 
const luminanceSource = new RGBLuminanceSource(luminancesUint8Array, 828, 1170, rawImageData.width, rawImageData.height, 0, 0);
const binaryBitmap = new BinaryBitmap(new HybridBinarizer(luminanceSource));

const result = qc.decode(binaryBitmap)

console.log(result.getText());