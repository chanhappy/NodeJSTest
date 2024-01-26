const { SM4 } = require('./sm4')
const ECB = 1
const CBC = 2
var key = "0123456789ABCDEFFEDCBA9876543210";
var iv = "00000000000000000000000000000000";
var originalData = "0123456789ABCDEFFEDCBA9876543210";
var encryptedData = new SM4({
    iv: iv,
    mode: CBC,
    inputEncoding: 'hex',
    outputEncoding: 'hex',
    isPkcs7Padding: true
}).encrypt(originalData, key);
console.log("encryptedData:", encryptedData);

var decryptedData = new SM4({
    iv: iv,
    mode: CBC,
    inputEncoding: 'hex',
    outputEncoding: 'hex',
    isPkcs7Padding: true
}).decrypt(encryptedData, key)
console.log("decryptedData:", decryptedData);

