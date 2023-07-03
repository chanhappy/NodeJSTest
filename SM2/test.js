const { BigInteger } = require('jsbn')
const SM2Cipher = require('./sm2')
const utils = require('./utils')

const C1C2C3 = 0

/**
 * 加密
 */
function doEncrypt(msg, publicKey, cipherMode = 1) {
    const cipher = new SM2Cipher()
    msg = utils.hexToArray(msg)

    if (publicKey.length > 128) {
        publicKey = publicKey.substr(publicKey.length - 128)
    }
    const xHex = publicKey.substr(0, 64)
    const yHex = publicKey.substr(64)
    publicKey = cipher.createPoint(xHex, yHex)

    const c1 = cipher.initEncipher(publicKey)

    cipher.encryptBlock(msg)
    const c2 = utils.arrayToHex(msg)

    let c3 = new Array(32)
    cipher.doFinal(c3)
    c3 = utils.arrayToHex(c3)
    return cipherMode === C1C2C3 ? c1 + c2 + c3 : c1 + c3 + c2
}

/**
 * 解密
 */
function doDecrypt(encryptData, privateKey, cipherMode = 1) {
    const cipher = new SM2Cipher()
    privateKey = new BigInteger(privateKey, 16)
    const c1X = encryptData.substr(0, 64)
    const c1Y = encryptData.substr(0 + c1X.length, 64)
    const c1Length = c1X.length + c1Y.length
    console.log("c1Length", c1Length);
    let c2 = encryptData.substr(c1Length + 64)
    if (cipherMode === C1C2C3) {
        c2 = encryptData.substr(c1Length, encryptData.length - c1Length - 64)
    }

    const data = utils.hexToArray(c2)
    const c1 = cipher.createPoint(c1X, c1Y)
    cipher.initDecipher(privateKey, c1)
    cipher.decryptBlock(data)
    const c3utils = new Array(32)
    cipher.doFinal(c3utils)

    return utils.arrayToHex(data)
}


var pubkeyHex = "a3034a408cf3308861cb75edf6a6f00fccecde5db35e1506af0a18253badc4e878776ecbd553a179bd5d3e478007de97ae531ba15f5cff2ef253ddb712739073"

var encryptData = doEncrypt("94934842434235465891973692438378", pubkeyHex, 0).toUpperCase();
console.log("encryptData:", encryptData);

var privateKey = "03389b6cc5de98c33ee7b082cc6c8617fcc47163c51888ca08eee82776a4c4e8"
var decryptData = doDecrypt(encryptData, privateKey, 0).toUpperCase();
console.log("decryptData:", decryptData);
