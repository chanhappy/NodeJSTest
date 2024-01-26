var forge = require('node-forge');
const { Buffer } = require('buffer');

function hexToString(hex_String) {
    var hex = hex_String.toString();
    var str = '';
    for (var n = 0; n < hex.length; n += 2) {
        str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
    }
    return str;
}

/**
* TripleDES encryption
*
* @method encrypt
* @param {String} key
* @param {String} text
*/
EncryptAsync = function (key, text, algorithm, encoding) {
    var cipher = forge.cipher.createCipher(algorithm, Buffer.from(key, encoding));
    cipher.start({ iv: '' });
    cipher.update(forge.util.createBuffer(text, encoding));
    cipher.finish();
    var encrypted = cipher.output;
    return forge.util.bytesToHex(encrypted);
}

/**
* TripleDES decryption
*
* @method decrypt
* @param {String} key
* @param {String} data (should be a base64 encoded string)
*/
DecryptAsync = function (key, data, algorithm, encoding) {
    var decipher = forge.cipher.createDecipher(algorithm, Buffer.from(key, encoding));
    data = forge.util.hexToBytes(data);
    decipher.start({ iv: '' });
    decipher.update(forge.util.createBuffer(data, encoding));
    decipher.finish();
    var decrypted = decipher.output;
    return hexToString(decrypted.toHex());
}

Encrypt = function (strData, strKey) {
    return EncryptAsync(strKey, strData, '3DES-ECB', 'utf-8');
}

Decrypt = function (strData, strKey) {
    return DecryptAsync(strKey, strData, '3DES-ECB', 'utf-8');
}

/**
* TripleDES encryption
*
* @method encrypt
* @param {String} key
* @param {String} text
*/
Encrypt4Base64 = function (key, text) {
    var cipher = forge.cipher.createCipher('3DES-ECB', Buffer.from(key, 'utf-8'));
    cipher.start({ iv: '' });
    cipher.update(forge.util.createBuffer(text, 'utf-8'));
    cipher.finish();
    var encrypted = cipher.output;
    return forge.util.encode64(encrypted.getBytes())
}

/**
* TripleDES decryption
*
* @method decrypt
* @param {String} key
* @param {String} data (should be a base64 encoded string)
*/
Decrypt4Base64 = function (key, data) {
    var decipher = forge.cipher.createDecipher('3DES-ECB', Buffer.from(key, 'utf-8'));
    data = forge.util.decode64(data);
    decipher.start({ iv: '' });
    decipher.update(forge.util.createBuffer(data, 'utf-8'));
    decipher.finish();
    var decrypted = decipher.output;
    return hexToString(decrypted.toHex());
}

let key = "123456789012345678901234";
let result1 = Encrypt("123456", key).toUpperCase();
console.log("result1=======", result1);
let result2 = Decrypt(result1, key).toUpperCase();
console.log("result2=======", result2);

let key1 = "BDB20085967886FC1D0F7078";
let text1 = "654321";
let result3 = Encrypt4Base64(key1, text1);
console.log("result3=======", result3);
let result4 = Decrypt4Base64(key1, result3);
console.log("result4=======", result4);



