vendor/flags -- the country flags, bundled, one SVG per country.
════════════════════════════════════════════════════════════════════

WHAT THESE ARE
    One 4:3 SVG per country code in main.js's GEO_COORDS table, which is the
    set of countries the app is willing to offer: spoofableOnly() drops every
    exit country it has no coordinates for, so a country that can appear in
    the picker always has a flag here, and a flag here always belongs to a
    country the picker can show.

WHERE THEY CAME FROM
    lipis/flag-icons -- https://github.com/lipis/flag-icons -- flags/4x3/<cc>.svg
    The project is MIT licensed; the flag artwork itself is public domain.
    Downloaded once, at development time, and committed. Nothing here is
    fetched at runtime.

WHY BUNDLED AND NOT FETCHED
    The app used to load https://flagcdn.com/w40/<cc>.png, one request per
    country, from the country-selection screen -- so a third party was told
    which country this user was about to connect to, over the user's real IP,
    before the tunnel existed. It was removed for that reason and replaced by
    a drawn two-letter badge.

    These files put the real flags back without putting the request back. The
    same folder is copied into Extension/flags so the browser popup draws the
    identical flag from its own package, with no host permission and no
    network of its own.

    The drawn badge did not go away: it is still painted underneath every
    flag, so a missing or unreadable file degrades to the old two-letter
    badge instead of a broken-image icon. Both surfaces build the badge from
    the same hue formula, so one country looks the same in the app window and
    in the popup.

INTEGRITY
    Every file is checked by .build/test-vendor.js: it is a real <svg>, it is
    self-contained (no <script>, no <foreignObject>, no href pointing off the
    file), and there is exactly one per GEO_COORDS country with nothing left
    over. An <img> cannot run script from an SVG in any case -- that is why
    these are drawn with <img src> and never inlined into the document.
