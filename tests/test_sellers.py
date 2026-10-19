import copy
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import sellers, catalog, main
from test_catalog import photo, Deferred


def seller(sid, kind='individual', name=None):
    return {'id':sid,'name':name or sid,'business_type':kind,'identity_verified':not sid.startswith('unresolved:'),'type_evidence':'사업자 구분 : '+kind,'evidence_url':'https://store.example/seller/'+sid}


def product(pid,sid,photo_id='p1',kind='individual',url=None):
    return {'url':url or 'https://store.example/products/'+pid,'name':pid,'category':'가방','seller':seller(sid,kind),'images':[{'url':'https://cdn.example/'+photo_id+'.png','pixel_sha256':photo_id,'sha256':photo_id,'informative':True}],'errors':[],'review':{'status':'unreviewed','notes':''}}


def report(products):
    return {'id':'test','created':'2026-10-19T00:00:00Z','site_url':'https://store.example/','mode':'seller_duplicates','status':'complete','stage':'완료','products':products,'counts':{'discovered':len(products),'checked':len(products),'candidates':0,'unverified':0},'warnings':[]}


def test_explicit_classification_and_no_name_based_guessing():
    html='<section data-seller-id="A" data-seller-name="리뷰상점"><dl><dt>사업자 구분</dt><dd>개인사업자</dd></dl></section>'
    result=sellers.parse_seller(html,'https://store.example/products/a')
    assert result['business_type']=='individual'
    assert result['identity_verified']
    assert '사업자 구분' in result['type_evidence']
    # No corporation word in a shop name does not establish sole proprietorship.
    unknown=sellers.parse_seller('<section class="seller"><p>판매자: 작은상점 · 사업자등록번호 123-45-67890</p></section>','https://store.example/products/b')
    assert unknown['business_type']=='unknown'
    assert not unknown['identity_verified']
    inline='<script type="application/ld+json">'+json.dumps({'@type':'Product','offers':{'seller':{'name':'A','@id':'#seller','businessType':'개인사업자'}}})+'</script>'
    assert not sellers.parse_seller(inline,'https://store.example/products/a')['identity_verified']
    # Platform footer must not classify the merchant.
    footer=sellers.parse_seller('<footer><table><tr><th>사업자 구분</th><td>법인사업자</td></tr></table></footer>','https://store.example/products/c')
    assert footer['business_type']=='unknown'


def test_structured_seller_and_multi_offer_ambiguity():
    def html(offers):return '<script type="application/ld+json">'+json.dumps({'@type':'Product','offers':offers})+'</script>'
    first={'seller':{'name':'상점A','url':'/seller/A','businessType':'개인사업자'}}
    assert sellers.parse_seller(html(first),'https://store.example/products/a')['business_type']=='individual'
    second={'seller':{'name':'상점B','url':'/seller/B','businessType':'개인사업자'}}
    result=sellers.parse_seller(html([first,second]),'https://store.example/products/a')
    assert result['business_type']=='unknown'
    assert not result['identity_verified']


def test_rank_counts_unique_products_and_separates_corporate_unknown():
    data=report([product('1','A'),product('2','A','p2'),product('3','A','p3'),product('4','B'),product('5','B','p4'),product('6','C','p2','corporation'),product('7','D','p1','unknown')])
    # Same photo twice on a product must not increase its weight.
    data['products'][0]['images']*=2
    result=sellers.summarize(data)
    a=next(s for s in result['sellers'] if s['id']=='A')
    assert (a['duplicate_products'],a['duplicate_ratio'],a['duplicate_groups'])==(2,66.7,2)
    assert result['sellers'][0]['id']=='A'
    assert result['counts']['candidates']==3
    assert result['seller_counts']=={'all':4,'individual':2,'corporation':1,'unknown':1}
    assert len(result['duplicate_image_groups'])==2
    assert all(p['review']['status']=='unreviewed' for p in result['products'])


def test_within_seller_repeat_does_not_claim_cross_seller_duplicate():
    result=sellers.summarize(report([product('1','A'),product('2','A')]))
    assert result['sellers'][0]['duplicate_products']==0
    assert result['sellers'][0]['within_seller_duplicate_products']==2
    assert result['counts']['candidates']==0


def test_unresolved_seller_identity_is_not_a_different_seller():
    result=sellers.summarize(report([product('1','unresolved:one'),product('2','unresolved:two')]))
    assert result['duplicate_image_groups']==[]
    assert result['counts']['candidates']==0


def test_coupang_shared_catalog_image_excluded_but_other_catalog_included():
    one=product('1','A',url='https://www.coupang.com/vp/products/100?itemId=11&vendorItemId=21')
    two=product('2','B',url='https://www.coupang.com/vp/products/100?itemId=12&vendorItemId=22')
    result=sellers.summarize(report([one,two]))
    assert result['counts']['candidates']==0
    assert all(p['catalog_shared_photo'] for p in result['products'])
    three=product('3','C',url='https://www.coupang.com/vp/products/200?itemId=13')
    result=sellers.summarize(report([one,two,three]))
    assert result['counts']['candidates']==3
    assert all(p['duplicate_groups'] for p in result['products'])


def test_conflicting_types_not_ranked_as_confirmed_individual():
    result=sellers.summarize(report([product('1','A'),product('2','A',kind='corporation'),product('3','B')]))
    assert next(s for s in result['sellers'] if s['id']=='A')['business_type']=='unknown'
    assert result['counts']['candidates']==1


def test_same_pixels_different_encoding_match_and_flat_images_excluded():
    source=photo()
    image=Image.open(io.BytesIO(source));out=io.BytesIO();image.save(out,'PNG',compress_level=0)
    one=catalog.image_features(source);two=catalog.image_features(out.getvalue())
    assert one['sha256']!=two['sha256']
    assert one['pixel_sha256']==two['pixel_sha256']
    data=report([product('1','A'),product('2','B')]);data['products'][0]['images'][0]['informative']=False
    assert sellers.summarize(data)['counts']['candidates']==0
    assert data['products'][0]['state']=='unverified'


def test_reference_free_mode_and_product_metadata_precedence():
    body=catalog.ScanInput(site_url='https://www.coupang.com/',mode='seller_duplicates')
    assert body.references==[]
    html='<script type="application/ld+json">'+json.dumps({'@type':'Product','name':'상품','image':'/real.png'})+'</script><meta property="og:image" content="/platform-logo.png"><header><img src="/logo.png"></header>'
    assert catalog.product_data(html,'https://store.example/p/1')[2]==['https://store.example/real.png']


def test_batch_confirm_validation_persistence_and_grouped_export(tmp_path,monkeypatch):
    path=tmp_path/'cases.sqlite3';monkeypatch.setattr(main,'DB',path)
    data=sellers.summarize(report([product('1','A'),product('2','B')]))
    catalog.put_scan(path,data)
    with TestClient(main.app) as client:
        base='/api/scans/test'
        payload={'product_urls':[data['products'][0]['url']],'status':'confirmed','notes':'','evidence_url':''}
        assert client.patch(base+'/reviews',json=payload).status_code==422
        payload.update(notes='상표권자에게 무단 사용 확인',evidence_url='javascript:alert(1)')
        assert client.patch(base+'/reviews',json=payload).status_code==422
        payload['evidence_url']='https://['
        assert client.patch(base+'/reviews',json=payload).status_code==422
        payload['evidence_url']='https://rights.example/evidence/1'
        assert client.patch(base+'/reviews',json=payload).status_code==200
        result=client.get(base+'/confirmed').json()
        assert result['product_count']==1
        assert len(result['sellers'])==1
        assert result['sellers'][0]['products'][0]['review']['source']=='user'
        assert client.get(base).json()['products'][1]['review']['status']=='unreviewed'
        # Atomic validation: unknown selection must not update another valid product.
        payload.update(product_urls=[data['products'][1]['url'],'https://unknown.example/p'],status='no_issue')
        assert client.patch(base+'/reviews',json=payload).status_code==422
        assert client.get(base).json()['products'][1]['review']['status']=='unreviewed'
        data['status']='running';catalog.put_scan(path,data)
        assert client.patch(base+'/reviews',json={**payload,'product_urls':[data['products'][0]['url']]}).status_code==409
