import base64
import socket

import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, 'DB', tmp_path / 'reviews.sqlite3')
    with TestClient(main.app) as test_client:
        yield test_client


def test_demo_review_roundtrip(client):
    response = client.post('/api/analyze', json={'url':'https://example.com/product', 'brand':'DEMO STUDIO', 'reference_text':'매일의 가벼움을 위한 오리지널 캔버스 디자인', 'demo':True})
    assert response.status_code == 200
    data = response.json()
    assert data['source'] == 'demo'
    assert [e['kind'] for e in data['evidence']] == ['브랜드명 일치', '문구 일치']
    saved = client.patch(f"/api/reviews/{data['id']}", json={'status':'추가 확인', 'notes':'판매 허가 확인 필요'})
    assert saved.status_code == 200
    assert saved.json()['notes'] == '판매 허가 확인 필요'
    assert client.get('/api/reviews').json()[0]['status'] == '추가 확인'
    assert client.get(f"/api/reviews/{data['id']}").json()['notes'] == '판매 허가 확인 필요'


def test_manual_no_match_does_not_claim_clearance(client):
    response = client.post('/api/analyze', json={'url':'https://example.com/item', 'brand':'원본브랜드', 'manual_text':'다른 상품입니다'})
    data = response.json()
    assert response.status_code == 200
    assert data['evidence'] == []
    assert data['signal'] == '일치 근거 미발견'
    assert data['source'] == 'manual'
    assert any('URL을 방문하지 않았습니다' in w for w in data['warnings'])


def test_page_fetch_extract_and_image(client, monkeypatch):
    image = b'\x89PNG\r\n\x1a\nfixture'
    calls = []
    def fetch(url, accepted):
        calls.append(url)
        if accepted == 'image/':
            return image, 'image/png', url
        return '<html><title>테스트 가방</title><script>비밀브랜드</script><h1>공식브랜드 가방</h1><p>매일 함께하는 오리지널 디자인입니다</p><img src="/item.png"></html>'.encode(), 'text/html', url
    monkeypatch.setattr(main, 'fetch_public', fetch)
    response = client.post('/api/analyze', json={'url':'https://example.com/item', 'brand':'공식브랜드', 'reference_text':'매일 함께하는 오리지널 디자인입니다', 'reference_image':base64.b64encode(image).decode()})
    data = response.json()
    assert response.status_code == 200
    assert data['title'] == '테스트 가방'
    assert '비밀브랜드' not in data['product_text']
    assert data['image_state'] == '동일 파일 확인'
    assert len(data['evidence']) == 3
    assert calls == ['https://example.com/item', 'https://example.com/item.png']


def test_fetch_failure_has_manual_fallback(client, monkeypatch):
    def fail(*args):
        raise ValueError('HTTP 403')
    monkeypatch.setattr(main, 'fetch_public', fail)
    response = client.post('/api/analyze', json={'url':'https://example.com/', 'brand':'테스트'})
    assert response.status_code == 422
    assert '직접 입력' in response.json()['detail']
    assert client.get('/api/reviews').json() == []


@pytest.mark.parametrize('url', ['file:///etc/passwd', 'http://user:pass@example.com/', 'http://example.com:8000/'])
def test_reject_invalid_url(url):
    with pytest.raises(ValueError):
        main.public_target(url)


@pytest.mark.parametrize('address', ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '192.168.1.1'])
def test_reject_private_resolved_address(address, monkeypatch):
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', (address, 80))])
    with pytest.raises(ValueError, match='공개 인터넷'):
        main.public_target('http://example.com')


def test_validate_redirect_destination(monkeypatch):
    class Response:
        status = 302
        def getheader(self, name, default=None):
            return 'http://127.0.0.1/' if name == 'Location' else default
    class Connection:
        def __init__(self, *a, **kw): pass
        def request(self, *a, **kw): pass
        def getresponse(self): return Response()
        def close(self): pass
    monkeypatch.setattr(socket, 'getaddrinfo', lambda host, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1' if host == '127.0.0.1' else '93.184.216.34', 80))])
    monkeypatch.setattr(main.http.client, 'HTTPConnection', Connection)
    with pytest.raises(ValueError, match='공개 인터넷'):
        main.fetch_public('http://example.com/', 'text/html')


def test_validation_and_static(client):
    assert client.get('/').status_code == 200
    assert client.get('/static/app.js').status_code == 200
    assert client.get('/api/health').json() == {'status':'ok'}
    assert client.post('/api/analyze', json={'url':'https://example.com'}).status_code == 422
    assert client.patch('/api/reviews/9999', json={'status':'invalid'}).status_code == 422
    assert client.get('/api/reviews/9999').status_code == 404
    assert client.post('/api/analyze', json={'url':'https://example.com', 'brand':'test', 'reference_image':'not base64'}).status_code == 422


def test_approved_proxy_route_and_redirect_gate(monkeypatch):
    monkeypatch.setenv('IPR_PROXY_ALLOWED_HOSTS', 'example.com')
    monkeypatch.setenv('HTTPS_PROXY', 'http://proxy.example:8080')
    requests = []
    def handler(request):
        requests.append(str(request.url))
        return main.httpx.Response(302, headers={'location':'http://127.0.0.1/'})
    original = main.httpx.Client
    monkeypatch.setattr(main.httpx, 'Client', lambda **kw: original(transport=main.httpx.MockTransport(handler)))
    monkeypatch.setattr(socket, 'getaddrinfo', lambda *a, **kw: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('127.0.0.1', 80))])
    with pytest.raises(ValueError, match='공개 인터넷'):
        main.fetch_public('https://example.com/', 'text/html')
    assert requests == ['https://example.com/']


def test_proxy_route_html_and_size_limit(monkeypatch):
    monkeypatch.setenv('IPR_PROXY_ALLOWED_HOSTS', 'example.com')
    monkeypatch.setenv('HTTPS_PROXY', 'http://proxy.example:8080')
    original = main.httpx.Client
    monkeypatch.setattr(main.httpx, 'Client', lambda **kw: original(transport=main.httpx.MockTransport(lambda req: main.httpx.Response(200, headers={'content-type':'text/html'}, content=b'<title>Product</title>'))))
    data, content_type, url = main.fetch_public('https://example.com/item', 'text/html')
    assert data == b'<title>Product</title>'
    assert content_type == 'text/html'
    monkeypatch.setattr(main, 'MAX_BYTES', 4)
    with pytest.raises(ValueError, match='2MB'):
        main.fetch_public('https://example.com/item', 'text/html')
