using Awp.Logging;
using Awp.SS.Cordova;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Org.BouncyCastle.Utilities.Encoders;
using Org.BouncyCastle.Math;
using Org.BouncyCastle.Math.EC;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Engines;

namespace Awp.SS.Cordova.Plugin.CryptoUtils
{
    /// <summary>
    /// SM2加解密
    /// </summary>
    [CordovaPlugin]
    public class SM2Utils : AttributedCordovaPlugin
    {
        private readonly ILog m_Logger = LogManager.GetLogger(typeof(SM2Utils));

        ECDomainParameters domainParams;
        ECCurve curve;

        /// <summary>
        /// SM2Utils
        /// </summary>
        public SM2Utils()
        {
            BigInteger SM2_ECC_P = new BigInteger("FFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFF", 16);
            BigInteger SM2_ECC_A = new BigInteger("FFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF00000000FFFFFFFFFFFFFFFC", 16);
            BigInteger SM2_ECC_B = new BigInteger("28E9FA9E9D9F5E344D5A9E4BCF6509A7F39789F515AB8F92DDBCBD414D940E93", 16);
            BigInteger SM2_ECC_N = new BigInteger("FFFFFFFEFFFFFFFFFFFFFFFFFFFFFFFF7203DF6B21C6052B53BBF40939D54123", 16);
            BigInteger SM2_ECC_H = BigInteger.One;
            BigInteger SM2_ECC_GX = new BigInteger("32C4AE2C1F1981195F9904466A39C9948FE30BBFF2660BE1715A4589334C74C7", 16);
            BigInteger SM2_ECC_GY = new BigInteger("BC3736A2F4F6779C59BDCEE36B692153D0A9877CC62A474002DF32E52139F0A0", 16);
            curve = new FpCurve(SM2_ECC_P, SM2_ECC_A, SM2_ECC_B, SM2_ECC_N, SM2_ECC_H);
            ECPoint g = curve.CreatePoint(SM2_ECC_GX, SM2_ECC_GY);
            domainParams = new ECDomainParameters(curve, g, SM2_ECC_N);
        }

        /// <summary>
        /// sm2加密
        /// </summary>
        /// <param name="publicKey">公钥</param>
        /// <param name= "plainText">加密数据的明文</param>
        /// <param name="callbackContext"></param>
        [CordovaPluginAction]
        public void Sm2Encrypt(string publicKey, string plainText, CallbackContext callbackContext)
        {
            m_Logger.Debug($"[SM2Utils]Sm2Encrypt=>publicKey:{publicKey}");
            m_Logger.Debug($"[SM2Utils]Sm2Encrypt=>plainText:{plainText}");

            if (string.IsNullOrWhiteSpace(publicKey))
            {
                m_Logger.Debug("[Sm2Encrypt]PublicKey is empty");
                return;
            }

            if (string.IsNullOrWhiteSpace(plainText))
            {
                m_Logger.Debug("[Sm2Encrypt]plainText is empty");
                return;
            }

            var data = Utils.HexStringToByteArray(plainText);
            BigInteger x = new BigInteger(publicKey.Substring(0, 64), 16);
            BigInteger y = new BigInteger(publicKey.Substring(64), 16);
            ECPoint point = curve.CreatePoint(x, y);
            ECPublicKeyParameters aPub = new ECPublicKeyParameters(point, domainParams);
            SM2Engine sm2Engine = new SM2Engine();
            sm2Engine.Init(true, new ParametersWithRandom(aPub));
            byte[] result = sm2Engine.ProcessBlock(data, 0, data.Length);
            m_Logger.Debug($"[SM2Utils]Sm2Encrypt=>Utils.ByteArrayToHexString(result):{Utils.ByteArrayToHexString(result)}");
            m_Logger.Debug($"[SM2Utils]Sm2Encrypt=>Utils.ByteArrayToHexString(result).Length:{Utils.ByteArrayToHexString(result).Length}");
            callbackContext.SendPluginResult(new PluginResult(PluginResult.Status.OK, Utils.ByteArrayToHexString(result).Substring(2)));
        }

        /// <summary>
        /// sm2解密
        /// </summary>
        /// <param name="privateKey">私钥</param>
        /// <param name= "cipherText">加密数据的密文</param>
        /// <param name="callbackContext"></param>
        [CordovaPluginAction]
        public void Sm2Decrypt(string privateKey, string cipherText, CallbackContext callbackContext)
        {
            m_Logger.Debug($"[SM2Utils]Sm2Decrypt=>privateKey:{privateKey}");
            m_Logger.Debug($"[SM2Utils]Sm2Decrypt=>cipherText:{cipherText}");

            if (string.IsNullOrWhiteSpace(privateKey))
            {
                m_Logger.Debug("[Sm2Decrypt]PrivateKey is empty");
                return;
            }

            if (string.IsNullOrWhiteSpace(cipherText))
            {
                m_Logger.Debug("[Sm2Decrypt]cipherText is empty");
                return;
            }

            BigInteger pri = new BigInteger(privateKey, 16);
            ECPrivateKeyParameters aPri = new ECPrivateKeyParameters(pri, domainParams);
            SM2Engine sm2Engine = new SM2Engine();
            sm2Engine.Init(false, aPri);
            byte[] cipherByte = Utils.HexStringToByteArray(cipherText);
            byte[] result = sm2Engine.ProcessBlock(cipherByte, 0, cipherByte.Length);
            m_Logger.Debug($"[SM2Utils]Sm2Decrypt=>Utils.ByteArrayToHexString(result):{Utils.ByteArrayToHexString(result)}");
            m_Logger.Debug($"[SM2Utils]Sm2Decrypt=>Utils.ByteArrayToHexString(result).Length:{Utils.ByteArrayToHexString(result).Length}");
            callbackContext.SendPluginResult(new PluginResult(PluginResult.Status.OK, Utils.ByteArrayToHexString(result)));
        }
    }
}
