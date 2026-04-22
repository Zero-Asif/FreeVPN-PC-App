@echo off
cd /d "%~dp0"

set CC=%1
set PORT=%2

taskkill /F /IM tor.exe >nul 2>&1

:: DNSPort 53 অ্যাড করা হলো যাতে Tor নিজেই DNS লিক ঠেকায়
start /B tor.exe SocksPort %PORT% DNSPort 53 ExitNodes {%CC%} StrictNodes 1 GeoIPFile "..\data\geoip" GeoIPv6File "..\data\geoip6" DataDirectory "..\data"

exit