'use strict';
//  Every country in main.js's built-in fallback list, against live Onionoo:
//  claimed count beside measured exit count. The fallback list is what the UI
//  offers when Onionoo is down, and StrictNodes 1 makes a country with no exit
//  an impossible circuit -- so an entry that flaps around zero is an
//  intermittent failed connect, not a slow one.
const path = require('path');
const { directGet } = require('../lib/socks-fetch');
const { RelayIndex } = require('../lib/exit-selector');
const { fallbackFromMainJs } = require('./geo-from-main.js');

const FLOOR = 3;
const log = { debug: () => {}, info: () => {}, warn: () => {} };

(async () => {
    const fallback = fallbackFromMainJs(path.join(__dirname, '..'));
    const idx = new RelayIndex(log);
    await idx.refresh(u => directGet(u, { timeoutMs: 45000, maxBytes: 12 * 1024 * 1024 }));
    const live = idx.countryStats();

    const rows = Object.keys(fallback).map(cc => ({
        cc,
        claimed: fallback[cc].count,
        measured: live[cc] ? live[cc].count : 0,
    })).sort((a, b) => a.measured - b.measured);

    console.log('  cc   claimed   measured');
    for (const r of rows) {
        const flag = r.measured === 0 ? '  DEAD'
                   : r.measured < FLOOR ? '  fragile'
                   : '';
        console.log('  ' + r.cc + String(r.claimed).padStart(9) +
                    String(r.measured).padStart(11) + flag);
    }
    const dead = rows.filter(r => r.measured === 0).map(r => r.cc);
    const thin = rows.filter(r => r.measured > 0 && r.measured < FLOOR).map(r => r.cc);
    console.log('\n  ' + rows.length + ' countries in the fallback list, ' +
                Object.keys(live).length + ' countries with live exits');
    console.log('  dead (0 exits)          : ' + (dead.join(' ') || 'none'));
    console.log('  below the floor of ' + FLOOR + '    : ' + (thin.join(' ') || 'none'));
})().catch(e => { console.log('ABORT: ' + e.message); process.exit(2); });
