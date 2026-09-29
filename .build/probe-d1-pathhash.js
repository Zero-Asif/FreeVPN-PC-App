'use strict';
//  Validate that our GenerateIdForPath reproduction is exactly Chromium's, by
//  checking it against ids Chromium itself wrote into the user's profile.
const c = require('crypto');
const mp = b => [...c.createHash('sha256').update(b).digest().subarray(0, 16)]
    .map(x => String.fromCharCode(97 + (x >> 4)) + String.fromCharCode(97 + (x & 15))).join('');
function f(p) {
    let s = p;
    if (s.length >= 2 && s[1] === ':' && s[0] >= 'a' && s[0] <= 'z') s = s[0].toUpperCase() + s.slice(1);
    return mp(Buffer.from(s, 'utf16le'));
}
const cases = [
    ['G:\\Personal Project\\Free-VPN-Extension', 'aoadoifmonclfkfmabohfhbigmioaanp'],
    ['C:\\Program Files\\FreeProxy VPN\\resources\\Extension', 'imlmcdmjclmlkhgljdokgjepcppgjfob'],
    ['C:\\Users\\User pc\\OneDrive\\Desktop\\LiveSubs', 'gmapjkemnfpfnmbhhoplbjjdcfejmfdk'],
    ['C:\\ProgramData\\freeproxy-vpn\\browser-setup\\extension', 'egclniilmgnaildaaiccpmakehnhledg'],
];
for (const [p, want] of cases) {
    const got = f(p);
    console.log(`${got === want ? 'MATCH  ' : 'DIFFERS'}  got ${got}  want ${want}   ${p}`);
}
