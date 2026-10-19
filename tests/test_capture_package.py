import json
from pathlib import Path
from zipfile import ZipFile


def test_download_package_matches_reviewable_source():
    root=Path(__file__).parents[1]
    package=root/'browser-capture'/'ipr-capture-extension.zip'
    with ZipFile(package) as archive:
        assert sorted(archive.namelist())==['README.txt','manifest.json','popup.html','popup.js']
        for name in archive.namelist():assert archive.read(name)==(root/'browser-capture'/name).read_bytes()
        manifest=json.loads(archive.read('manifest.json'))
        assert manifest['permissions']==['activeTab','scripting']
        assert 'content_scripts' not in manifest
        assert manifest['optional_host_permissions']==['https://*.coupangcdn.com/*']
    assert (root/'app/static/ipr-capture-extension.zip').read_bytes()==package.read_bytes()
