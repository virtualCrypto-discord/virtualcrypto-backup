#!/usr/bin/env python3
import json
import os
import time
import urllib.request
url = os.environ['BACKUP_URL'].rstrip('/')
if not url.startswith('https://'):
    raise RuntimeError('HTTPS is required')
request = urllib.request.Request(url + '/status', headers={'Authorization': 'Bearer ' + os.environ['STATUS_TOKEN']})
with urllib.request.urlopen(request, timeout=30) as response:
    status = json.load(response)
last = status['last_success']
if not last or time.time() - last / 1000 > 30 * 3600:
    raise SystemExit('ERROR: no successful backup in the last 30 hours')
print('Backup is fresh; reserved bytes:', status['reserved_bytes'])
