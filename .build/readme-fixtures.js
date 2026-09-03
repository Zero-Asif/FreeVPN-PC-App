'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/readme-fixtures.js  --  the fixed values every README picture uses.
//
//  WHY THIS FILE EXISTS
//  Two harnesses photograph two surfaces of the same product: the app window
//  (probe-readme-shots.js) and the browser popup (probe-readme-popup.js). The
//  popup is meant to be a VIEW of the app, and popup.js says so in its own
//  first comment -- "a popup that disagrees with the app is a popup that
//  lies". If each harness carried its own country table, the README could end
//  up showing "United States - 612 exits" in the app window and a different
//  number for the same country in the popup beside it, in the same document,
//  as evidence of the two agreeing. That is the drift geo-from-main.js was
//  written to stop for GEO_COORDS; this is the same rule for the fixtures.
//
//  These numbers are FIXTURES, not measurements: the shape is the real shape
//  of what get-realtime-status returns (a {cc: {count, bandwidth}} map read
//  from the live Tor relay index), and the values are plausible, but they are
//  invented so the pictures are reproducible and carry nothing about the
//  machine they were taken on. docs/media/README.md says so out loud.
// ════════════════════════════════════════════════════════════════════

//  The exit-relay counts both country lists are built from, sorted by
//  bandwidth exactly as renderer.js and popup.js sort them. The bands the
//  numbers fall into matter more than the numbers: popup.js grade() calls
//  >200 exits or >50 Mbps 'fast', >50 or >10 'busy', and the rest 'slow', so
//  the list has to contain enough of each for the picture to show all three.
const SERVERS = {
    us: { count: 612, bandwidth: 9_400_000_000 }, de: { count: 487, bandwidth: 8_100_000_000 },
    nl: { count: 231, bandwidth: 5_200_000_000 }, fr: { count: 176, bandwidth: 4_050_000_000 },
    fi: { count: 143, bandwidth: 3_400_000_000 }, se: { count: 342, bandwidth: 3_100_000_000 },
    ch: { count: 96,  bandwidth: 2_300_000_000 }, gb: { count: 88,  bandwidth: 2_050_000_000 },
    ca: { count: 74,  bandwidth: 1_600_000_000 }, at: { count: 41,  bandwidth: 940_000_000 },
    ro: { count: 52,  bandwidth: 1_010_000_000 }, pl: { count: 37,  bandwidth: 720_000_000 },
    jp: { count: 23,  bandwidth: 430_000_000 },   cz: { count: 31,  bandwidth: 610_000_000 },
    es: { count: 26,  bandwidth: 520_000_000 },   it: { count: 21,  bandwidth: 410_000_000 },
    sg: { count: 16,  bandwidth: 310_000_000 },   dk: { count: 14,  bandwidth: 290_000_000 },
    no: { count: 13,  bandwidth: 270_000_000 },   lu: { count: 12,  bandwidth: 250_000_000 },
    //  The two the ask-dialog shots need. India is an ordinary mid-sized pool;
    //  Bangladesh is deliberately at the bottom, because a country with two
    //  exits is exactly the one whose relay can be gone by the time you press
    //  Connect -- which is the state shots 06, 08 and 09 are about.
    in: { count: 34,  bandwidth: 640_000_000 },   bd: { count: 2,   bandwidth: 8_000_000 },
};

//  An INVENTED home location. The idle badge prints "Standing by in <city>,
//  <country>" from whatever home-location resolves to, and the older globe
//  probes hardcode this machine's real city -- which would publish the
//  developer's home town in a public README. London is a stand-in and is
//  labelled as one in docs/media/README.md.
const HOME = { lat: 51.5074, lng: -0.1278, city: 'London', country: 'United Kingdom', cc: 'GB' };

//  The country every "connected" picture connects to, in both harnesses.
const SHOWN_CC = 'jp';

//  index.html:123 ships a split-tunnel placeholder naming two real companies.
//  Every picture overrides it with these two reserved example hosts instead:
//  a screenshot in a public README is metadata, and metadata carrying someone
//  else's trademark is a store-review question nobody needs to answer. This is
//  the ONE thing in the images that is not byte-for-byte what the app ships,
//  and docs/media/README.md records it.
const BYPASS_PLACEHOLDER = 'e.g. mybank.example; intranet.local';
const BYPASS_FILLED      = 'mybank.example; intranet.local';

//  Session clocks are pinned so a regenerated image still diffs cleanly.
const SESSION_MS = { connected: 41 * 60_000 + 12_000, controls: 67 * 60_000 + 35_000 };

module.exports = { SERVERS, HOME, SHOWN_CC, BYPASS_PLACEHOLDER, BYPASS_FILLED, SESSION_MS };
