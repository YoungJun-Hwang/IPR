from __future__ import annotations

import base64
from contextlib import asynccontextmanager
import binascii
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import sqlite3
import httpx
import ssl
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DB = Path(os.environ.get('IPR_DB_PATH', str(ROOT.parent / '.data' / 'reviews.sqlite3')))
MAX_BYTES = 2 * 1024 * 1024
from app import catalog


@asynccontextmanager
async def lifespan(application):
    catalog.recover_scans(DB)
    yield


app = FastAPI(title='IPR · 권리 검토 워크스페이스', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')


def database():
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    con.execute('CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY, created TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL, payload TEXT NOT NULL)')
    return con


def web_target(url: str):
    parts = urlsplit(url)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        raise ValueError('인증 정보가 없는 http 또는 https 상품 URL을 입력해 주세요.')
    port = parts.port or (443 if parts.scheme == 'https' else 80)
    if port not in (80, 443):
        raise ValueError('표준 웹 포트(80, 443)만 사용할 수 있습니다.')
    return parts, port


def public_target(url: str):
    parts, port = web_target(url)
    addresses = socket.getaddrinfo(parts.hostname, port, type=socket.SOCK_STREAM)
    ips = [item[4][0] for item in addresses]
    if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
        raise ValueError('공개 인터넷의 상품 URL만 분석할 수 있습니다.')
    return parts, port, ips[0]


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, host, port, address):
        super().__init__(host, port, timeout=12, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def proxy_response(url: str, accepted: str):
    """Use the operator-approved proxy route only for explicitly trusted DNS hosts.

    In this mode the proxy resolves DNS; destination control is the exact hostname
    list plus the cloud's network policy. No arbitrary user hostname is proxied.
    """
    parts, _ = web_target(url)
    approved = {x.strip().lower() for x in os.environ.get('IPR_PROXY_ALLOWED_HOSTS', '').split(',') if x.strip()}
    proxy_key = 'HTTPS_PROXY' if parts.scheme == 'https' else 'HTTP_PROXY'
    proxy = os.environ.get(proxy_key) or os.environ.get(proxy_key.lower())
    if not proxy or parts.hostname.lower() not in approved:
        return None
    try:
        address = ipaddress.ip_address(parts.hostname)
    except ValueError:
        address = None
    if address is not None:
        # Proxy destinations must be operator-approved DNS names, never IP literals.
        raise ValueError('프록시 수집에는 승인된 공개 도메인 이름만 사용할 수 있습니다.')
    if parts.hostname.lower() in ('localhost',) or '.' not in parts.hostname or parts.hostname.lower().endswith(('.localhost', '.local', '.internal')):
        raise ValueError('로컬 도메인은 수집할 수 없습니다.')
    # Explicit proxy avoids NO_PROXY causing an unvalidated direct connection.
    with httpx.Client(proxy=proxy, timeout=12, follow_redirects=False, trust_env=True) as client:
        with client.stream('GET', url, headers={'User-Agent':'IPR-Review/0.1', 'Accept-Encoding':'identity'}) as response:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get('location')
                if not location:
                    raise ValueError('이동할 주소가 없는 응답입니다.')
                return ('redirect', urljoin(url, location))
            if response.status_code != 200:
                raise ValueError(f'상품 페이지 요청이 거절되었습니다 (HTTP {response.status_code}). 프록시 네트워크 허용 도메인도 확인해 주세요.')
            content_type = response.headers.get('content-type', '').lower()
            if accepted not in content_type:
                raise ValueError('지원하지 않는 콘텐츠 형식입니다.')
            chunks = []
            size = 0
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > MAX_BYTES:
                    raise ValueError('콘텐츠 크기는 2MB 이하여야 합니다.')
                chunks.append(chunk)
            return ('content', (b''.join(chunks), content_type, url))


def fetch_public(url: str, accepted: str):
    """Revalidate redirects; direct requests pin IPs, proxy requests require approved hosts."""
    for _ in range(4):
        proxied = proxy_response(url, accepted)
        if proxied is not None:
            if proxied[0] == 'redirect':
                url = proxied[1]
                continue
            return proxied[1]
        try:
            parts, port, address = public_target(url)
        except socket.gaierror:
            raise ValueError('서버의 직접 DNS 조회가 불가능합니다. 프록시 환경에서는 운영자가 상품·이미지 도메인을 IPR_PROXY_ALLOWED_HOSTS와 환경의 네트워크 허용 목록에 등록해야 합니다.')
        if parts.scheme == 'https':
            conn = PinnedHTTPS(parts.hostname, port, address)
        else:
            conn = http.client.HTTPConnection(address, port, timeout=12)
        try:
            path = (parts.path or '/') + ('?' + parts.query if parts.query else '')
            host = parts.hostname
            if ':' in host:
                host = '[' + host + ']'
            conn.request('GET', path, headers={'Host': host, 'User-Agent': 'IPR-Review/0.1', 'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                location = response.getheader('Location')
                if not location:
                    raise ValueError('이동할 주소가 없는 응답입니다.')
                url = urljoin(url, location)
                continue
            if response.status != 200:
                raise ValueError(f'상품 페이지 요청이 거절되었습니다 (HTTP {response.status}). 공개 접근 가능한 URL을 사용해 주세요.')
            content_type = response.getheader('Content-Type', '').lower()
            if accepted not in content_type:
                raise ValueError('지원하지 않는 콘텐츠 형식입니다.')
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError('콘텐츠 크기는 2MB 이하여야 합니다.')
            return data, content_type, url
        finally:
            conn.close()
    raise ValueError('페이지 이동 횟수를 초과했습니다.')


class AnalysisInput(BaseModel):
    url: str = Field(max_length=2048)
    brand: str = Field(default='', max_length=120)
    registration: str = Field(default='', max_length=300)
    reference_text: str = Field(default='', max_length=30000)
    reference_image: str = Field(default='', max_length=2800000)
    reference_filename: str = Field(default='', max_length=200)
    manual_text: str = Field(default='', max_length=30000)
    demo: bool = False


class ReviewInput(BaseModel):
    status: str
    notes: str = Field(default='', max_length=5000)


def normalize(text):
    return re.sub(r'\s+', ' ', text).strip().casefold()


def extract_page(data: bytes, url: str):
    soup = BeautifulSoup(data, 'html.parser')
    title = soup.find('meta', property='og:title')
    title = title.get('content', '') if title else (soup.title.get_text(' ', strip=True) if soup.title else '상품 페이지')
    images = []
    for tag in soup.select('meta[property="og:image"], img[src]'):
        source = tag.get('content') or tag.get('src')
        if source:
            full = urljoin(url, source)
            if full.startswith(('https://', 'http://')) and full not in images:
                images.append(full)
    for tag in soup(['script', 'style', 'nav', 'footer', 'noscript']):
        tag.decompose()
    return title[:300], soup.get_text(' ', strip=True)[:60000], images[:3]


def compare_text(brand, reference, product):
    normalized = normalize(product)
    brand_found = bool(brand.strip()) and normalize(brand) in normalized
    segments = [x.strip() for x in re.split(r'[\n.!?。]+', reference) if len(normalize(x)) >= 12]
    matches = list(dict.fromkeys(x for x in segments if normalize(x) in normalized))[:12]
    evidence = []
    if brand_found:
        pos = normalized.find(normalize(brand))
        evidence.append({'kind': '브랜드명 일치', 'reference': brand, 'observed': normalized[max(0, pos-45):pos+len(brand)+85]})
    for match in matches:
        evidence.append({'kind': '문구 일치', 'reference': match, 'observed': match})
    return evidence


@app.get('/')
def index():
    return FileResponse(ROOT / 'static' / 'index.html')


@app.get('/api/health')
def health():
    with database() as con:
        con.execute('SELECT 1').fetchone()
    return {'status': 'ok'}


@app.post('/api/analyze')
def analyze(body: AnalysisInput):
    if not body.brand.strip() and not body.reference_text.strip() and not body.reference_image:
        raise HTTPException(422, '브랜드명, 권리 문구, 원본 이미지 중 하나 이상을 등록해 주세요.')
    image_bytes = None
    if body.reference_image:
        try:
            image_bytes = base64.b64decode(body.reference_image, validate=True)
        except (ValueError, binascii.Error):
            raise HTTPException(422, '원본 이미지 형식이 올바르지 않습니다.')
        if len(image_bytes) > MAX_BYTES:
            raise HTTPException(422, '원본 이미지는 2MB 이하여야 합니다.')
        if not image_bytes.startswith((b'\x89PNG\r\n\x1a\n', b'\xff\xd8\xff', b'GIF87a', b'GIF89a', b'RIFF')):
            raise HTTPException(422, 'PNG, JPEG, GIF, WebP 이미지를 사용해 주세요.')
    warnings = []
    if body.demo:
        title = 'DEMO STUDIO · 시그니처 캔버스백'
        text = 'DEMO STUDIO 시그니처 캔버스백. 매일의 가벼움을 위한 오리지널 캔버스 디자인.'
        images = []
        source = 'demo'
    elif body.manual_text.strip():
        # No fetch in manual mode, but reject malformed/non-web URLs.
        try:
            parts = urlsplit(body.url)
            if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, '상품 출처의 http 또는 https URL을 입력해 주세요.')
        title, text, images = '직접 입력한 상품 자료', body.manual_text, []
        source = 'manual'
        warnings.append('URL을 방문하지 않았습니다. 사용자가 입력한 상품 설명만 비교했습니다.')
    else:
        try:
            html, _, final_url = fetch_public(body.url, 'text/html')
            title, text, images = extract_page(html, final_url)
        except (ValueError, OSError, http.client.HTTPException, httpx.HTTPError) as exc:
            detail = str(exc) if isinstance(exc, ValueError) else '네트워크 연결 또는 TLS 검증에 실패했습니다.'
            raise HTTPException(422, f'페이지를 가져오지 못했습니다. {detail} 자동 수집이 막힌 경우 상품 설명을 직접 입력해 주세요.')
        source = 'url'
        warnings.append('공개 HTML만 확인했습니다. 로그인·자바스크립트로 표시되는 상품 정보는 누락될 수 있습니다.')
    evidence = compare_text(body.brand, body.reference_text, text)
    image_state = '미등록'
    if image_bytes is not None:
        image_state = '미검증'
        if not images:
            warnings.append('비교할 상품 이미지가 없어 이미지 일치 검사를 수행하지 않았습니다.')
        checked = 0
        matched = False
        for image_url in images:
            try:
                remote, _, _ = fetch_public(image_url, 'image/')
                checked += 1
                if hashlib.sha256(remote).digest() == hashlib.sha256(image_bytes).digest():
                    matched = True
                    evidence.append({'kind': '이미지 파일 동일', 'reference': body.reference_filename or '원본 이미지', 'observed': image_url})
            except (ValueError, OSError, http.client.HTTPException, httpx.HTTPError):
                warnings.append('상품 이미지 하나를 가져오지 못했습니다. 이미지 비교가 일부 누락되었습니다.')
        if checked:
            image_state = '동일 파일 확인' if matched else '검사한 파일에서 동일 파일 없음'
        warnings.append('이미지는 최대 3개 파일의 SHA-256 동일성만 비교합니다. 크기·압축·편집이 다른 이미지의 시각적 유사성은 분석하지 않습니다.')
    warnings.append('일치 여부는 침해 판단이 아닙니다. 정식 판매·이용 허락·권리 범위를 별도로 확인해 주세요. 등록번호는 기록용이며 공적 등록정보 조회는 수행하지 않습니다.')
    payload = {'url': body.url, 'title': title, 'brand': body.brand, 'registration': body.registration,
               'reference_text': body.reference_text, 'reference_filename': body.reference_filename,
               'product_text': text, 'source': source, 'evidence': evidence, 'image_state': image_state,
               'warnings': warnings, 'signal': '검토할 일치 항목 있음' if evidence else '일치 근거 미발견'}
    created = datetime.now(timezone.utc).isoformat()
    with database() as con:
        cursor = con.execute('INSERT INTO reviews (created,status,notes,payload) VALUES (?,?,?,?)', (created, '검토 필요', '', json.dumps(payload, ensure_ascii=False)))
        review_id = cursor.lastrowid
    return {'id': review_id, 'created': created, 'status': '검토 필요', 'notes': '', **payload}


@app.get('/api/reviews')
def reviews():
    with database() as con:
        rows = con.execute('SELECT * FROM reviews ORDER BY id DESC LIMIT 100').fetchall()
    return [{'id': row['id'], 'created': row['created'], 'status': row['status'], 'notes': row['notes'], **json.loads(row['payload'])} for row in rows]


@app.get('/api/reviews/{review_id}')
def review(review_id: int):
    with database() as con:
        row = con.execute('SELECT * FROM reviews WHERE id=?', (review_id,)).fetchone()
    if row is None:
        raise HTTPException(404, '검토 기록을 찾을 수 없습니다.')
    return {'id': row['id'], 'created': row['created'], 'status': row['status'], 'notes': row['notes'], **json.loads(row['payload'])}


@app.patch('/api/reviews/{review_id}')
def update_review(review_id: int, body: ReviewInput):
    if body.status not in ('검토 필요', '문제없음', '추가 확인'):
        raise HTTPException(422, '지원하지 않는 검토 상태입니다.')
    with database() as con:
        cursor = con.execute('UPDATE reviews SET status=?, notes=? WHERE id=?', (body.status, body.notes, review_id))
        if not cursor.rowcount:
            raise HTTPException(404, '검토 기록을 찾을 수 없습니다.')
    return review(review_id)


# Long-running catalog scans are local Python worker jobs, not GitHub Pages functions.
@app.post('/api/scans', status_code=202)
def create_scan(body: catalog.ScanInput):
    try:
        return catalog.start_scan(DB, body, fetch_public)
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@app.get('/api/scans')
def scans():
    return catalog.list_scans(DB)


@app.get('/api/scans/{scan_id}')
def scan_status(scan_id: str):
    scan = catalog.get_scan(DB, scan_id)
    if scan is None:
        raise HTTPException(404, '점검 기록을 찾을 수 없습니다.')
    return scan
