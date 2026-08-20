const crypto = require('node:crypto');

function ValidateSignature(payload, signature, secret)
{
    if (!Buffer.isBuffer(payload) || !signature || !signature.startsWith('sha256='))
    {
        return false;
    }

    let providedHash;
    try
    {
        providedHash = Buffer.from(signature.substring('sha256='.length), 'hex');
    }
    catch (error)
    {
        return false;
    }
    if (providedHash.length !== 32)
    {
        return false;
    }

    const expectedHash = crypto.createHmac('sha256', secret).update(payload).digest();
    return crypto.timingSafeEqual(providedHash, expectedHash);
}

module.exports.ValidateSignature = ValidateSignature;
