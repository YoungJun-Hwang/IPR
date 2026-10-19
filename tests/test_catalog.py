import base64
import io
import json
import random
from concurrent.futures import Future

import pytest
from PIL import Image, ImageDraw
from fastapi.testclient import TestClient

from app import catalog, main


def photo():
    image=Image.new('RGB',(240,240),'white')
    draw=ImageDraw.Draw(image)
    draw.rounded_rectangle((40,70,200,210),radius=15,fill='#355b43',outline='black',width=5)
    draw.arc((70,15,170,130),180,360,fill='black',width=10)
    draw.rectangle((60,130,180,150),fill='#d4b25f')
    out=io.BytesIO();image.save(out,'PNG')
    return out.getvalue()


def noise():
    rng=random.Random(42)
    image=Image.frombytes('RGB',(240,240),rng.randbytes(240*240*3))
    out=io.BytesIO();image.save(out,'PNG')
    return out.getvalue()


class Deferred:
    def submit(self,*args):return Future()


@pytest.fixture
def setup(tmp_path,monkeypatch):
    monkeypatch.setattr(catalog,'POOL',Deferred())
    body=catalog.ScanInput(site_url='https://store.example/',references=[{'name':'원본 가방','image':base64.b64encode(photo()).decode()}])
    return tmp_path/'scan.sqlite3',body


def fake_store(url,accepted):
    pages={
      'https://store.example/robots.txt':b'User-agent: *\nAllow: /',
      'https://store.example/':'<a href="/collections/bags">가방</a><a href="/collections/shoes">신발</a>'.encode(),
      'https://store.example/collections/bags':b'<a href="/products/a"><img src="/a.png">A</a><a href="/products/b">B</a>',
      'https://store.example/collections/shoes':b'<a href="/products/c">C</a>',
      'https://store.example/products/a':('<script type="application/ld+json">'+json.dumps({'@type':'Product','name':'유사 가방','image':'/a.png','category':'가방'})+'</script>').encode(),
      'https://store.example/products/b':b'<h1>Other bag</h1><meta property="og:image" content="/b.png">',
      'https://store.example/products/c':b'<h1>Unavailable shoe</h1><img src="/c.png">',
      'https://store.example/a.png':photo(),
      'https://store.example/b.png':noise(),
    }
    if url not in pages:raise ValueError('HTTP 404')
    return pages[url], 'image/png' if accepted=='image/' else 'text/html', url


def test_phash_resized_jpeg_and_unrelated_images():
    original=catalog.image_features(photo())
    image=Image.open(io.BytesIO(photo())).resize((180,180))
    out=io.BytesIO();image.save(out,'JPEG',quality=80)
    score,reason=catalog.similarity(original,catalog.image_features(out.getvalue()))
    assert score>=88
    assert reason=='pHash 시각적 유사성'
    assert catalog.similarity(original,catalog.image_features(noise()))[0]<88
    assert catalog.similarity(original,original)==(100.0,'동일 이미지 파일')


def test_low_information_images_not_false_matches():
    left=Image.new('RGB',(100,100),'white');right=Image.new('RGB',(100,100),'gray')
    raw=[]
    for image in (left,right):
        out=io.BytesIO();image.save(out,'PNG');raw.append(catalog.image_features(out.getvalue()))
    assert catalog.similarity(*raw)[0] is None


def test_category_crawl_candidate_and_unverified_separation(setup):
    path,body=setup
    created=catalog.start_scan(path,body,fake_store)
    refs=[{'name':'원본 가방',**catalog.image_features(photo())}]
    catalog.run_scan(path,created['id'],body,refs,fake_store,delay=0)
    report=catalog.get_scan(path,created['id'])
    assert report['status']=='complete'
    assert report['counts']=={'discovered':3,'checked':3,'candidates':1,'unverified':1}
    assert report['products'][0]['name']=='유사 가방'
    assert report['products'][0]['score']==100.0
    assert report['products'][0]['category']=='가방'
    assert report['products'][-1]['state']=='unverified'
    assert len(catalog.list_scans(path))==1
    assert 'products' not in catalog.list_scans(path)[0]
    assert 'image' not in report['references'][0]


def test_robots_disallow_blocks_crawl(setup):
    path,body=setup
    calls=[]
    def blocked(url,accepted):
        calls.append(url)
        return b'User-agent: *\nDisallow: /','text/plain',url
    created=catalog.start_scan(path,body,blocked)
    catalog.run_scan(path,created['id'],body,[],blocked,delay=0)
    result=catalog.get_scan(path,created['id'])
    assert result['status']=='failed'
    assert 'robots.txt' in result['stage']
    assert calls==['https://store.example/robots.txt']


def test_missing_robots_404_allows_but_403_stops(setup):
    path,body=setup
    for status in ('404','403'):
        calls=[]
        def fetch(url,accepted):
            calls.append(url)
            if url.endswith('/robots.txt'):raise ValueError('HTTP '+status)
            return fake_store(url,accepted)
        created=catalog.start_scan(path,body,fetch)
        catalog.run_scan(path,created['id'],body,[{'name':'원본',**catalog.image_features(photo())}],fetch,delay=0)
        result=catalog.get_scan(path,created['id'])
        assert result['status']==('complete' if status=='404' else 'failed')
        if status=='403':assert len(calls)==1


def test_sitemap_fallback_and_limits(setup):
    path,body=setup
    body.max_products=1
    def fetch(url,accepted):
        if url=='https://store.example/':return b'<h1>Shop</h1>','text/html',url
        if url.endswith('/sitemap.xml'):return b'<urlset><url><loc>https://store.example/products/a</loc></url><url><loc>https://store.example/products/b</loc></url><url><loc>http://127.0.0.1/products/private</loc></url></urlset>','application/xml',url
        return fake_store(url,accepted)
    created=catalog.start_scan(path,body,fetch)
    catalog.run_scan(path,created['id'],body,[{'name':'원본',**catalog.image_features(photo())}],fetch,delay=0)
    result=catalog.get_scan(path,created['id'])
    assert result['status']=='complete'
    assert result['counts']['discovered']==2
    assert result['counts']['checked']==1


def test_parser_dedup_links_and_external_boundaries():
    html=b'<a href="/collections/a">A</a><a href="/products/1#image">p</a><a href="http://127.0.0.1/products/2">bad</a><a href="/product/list.html?cate_no=2">B</a><a href="/collections/a?page=2" rel="next">next</a>'
    categories,products,next_pages=catalog.parse_listing(html,'https://store.example/','store.example')
    assert len(products)==1
    assert products[0]['url']=='https://store.example/products/1'
    assert next_pages==['https://store.example/collections/a?page=2']
    assert len(categories)==3


def test_job_api_and_restart_recovery(setup,monkeypatch):
    path,body=setup
    monkeypatch.setattr(main,'DB',path)
    with TestClient(main.app) as client:
        response=client.post('/api/scans',json=body.model_dump())
        assert response.status_code==202
        scan_id=response.json()['id']
        assert client.get('/api/scans/'+scan_id).json()['status']=='queued'
        assert len(client.get('/api/scans').json())==1
        assert client.get('/api/scans/missing').status_code==404
        bad=body.model_dump();bad['references'][0]['image']='bad'
        assert client.post('/api/scans',json=bad).status_code==422
    catalog.recover_scans(path)
    assert catalog.get_scan(path,scan_id)['status']=='failed'


def test_bad_image_and_concurrency_bound(setup):
    path,body=setup
    with pytest.raises(ValueError,match='이미지'):
        catalog.image_features(b'not an image')
    catalog.start_scan(path,body,fake_store)
    catalog.start_scan(path,body,fake_store)
    with pytest.raises(ValueError,match='2개'):
        catalog.start_scan(path,body,fake_store)


def test_large_robots_crawl_delay_stops_without_ignoring_policy(setup):
    path,body=setup
    calls=[]
    def fetch(url,accepted):
        calls.append(url)
        return b'User-agent: *\nAllow: /\nCrawl-delay: 60','text/plain',url
    created=catalog.start_scan(path,body,fetch)
    catalog.run_scan(path,created['id'],body,[],fetch,delay=0)
    result=catalog.get_scan(path,created['id'])
    assert result['status']=='failed'
    assert '요청 간격' in result['stage']
    assert calls==['https://store.example/robots.txt']


def test_candidate_with_missing_image_remains_candidate_but_counts_as_partial(setup):
    path,body=setup
    def fetch(url,accepted):
        if url=='https://store.example/':return b'<a href="/products/a">A</a>','text/html',url
        if url.endswith('/products/a'):
            return b'<h1>Candidate</h1><img src="/a.png"><img src="/missing.png">','text/html',url
        return fake_store(url,accepted)
    created=catalog.start_scan(path,body,fetch)
    catalog.run_scan(path,created['id'],body,[{'name':'원본',**catalog.image_features(photo())}],fetch,delay=0)
    report=catalog.get_scan(path,created['id'])
    assert report['products'][0]['state']=='candidate'
    assert report['products'][0]['errors']
    assert report['counts']['candidates']==1
    assert report['counts']['unverified']==1
