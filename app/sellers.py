"""Explicit seller classification, exact-photo reuse ranking and review exports."""
import hashlib
import json
import re
from collections import defaultdict
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

TYPES = {'개인사업자':'individual', '개인 사업자':'individual', 'sole_proprietor':'individual',
         '법인사업자':'corporation','법인 사업자':'corporation','corporation':'corporation'}
TYPE_LABEL = re.compile(r'^(?:사업자\s*(?:유형|구분|형태)|판매자\s*(?:유형|구분))\s*[:：]?$')
NAME_LABEL = re.compile(r'^(?:상호|업체명|판매자명|상호명)\s*[:：]?$')


def parse_seller(html, base, detail=False):
    soup = BeautifulSoup(html,'html.parser')
    seller={'id':'','name':'판매자 확인 불가','url':'','business_type':'unknown','type_evidence':'','evidence_url':base}
    possible=[]
    for script in soup.select('script[type="application/ld+json"]'):
        try: raw=json.loads(script.get_text())
        except (ValueError,TypeError):continue
        def visit(value):
            if isinstance(value,list):
                for item in value:yield from visit(item)
            elif isinstance(value,dict):
                types=value.get('@type',[])
                if types=='Product' or isinstance(types,list) and 'Product' in types:
                    offers=value.get('offers',[])
                    for offer in offers if isinstance(offers,list) else [offers]:
                        if isinstance(offer,dict) and isinstance(offer.get('seller'),dict):yield offer['seller']
                if '@graph' in value:yield from visit(value['@graph'])
        possible.extend(visit(raw))
    distinct={json.dumps(item,sort_keys=True,ensure_ascii=False) for item in possible}
    if len(distinct)>1:
        seller['type_evidence']='복수 판매자 상품으로 대표 판매자를 확인하지 못했습니다.'
        seller['ambiguous']=True
    elif possible:
        data=possible[0]
        seller['name']=str(data.get('name') or seller['name'])[:150]
        value=data.get('url') or data.get('@id')
        if isinstance(value,str):
            candidate=urljoin(base,value)
            # An inline #seller entity on a product page is not a stable shop ID.
            if urlsplit(candidate).path!=urlsplit(base).path or urlsplit(candidate).query!=urlsplit(base).query:
                seller['url']=candidate
        explicit=str(data.get('businessType') or '')
        if explicit in TYPES:
            seller.update(business_type=TYPES[explicit],type_evidence='공개 판매자 구조화 정보: '+explicit)
    blocks=soup.select('[data-seller-id], [data-seller-info], [id*="seller"], [class*="seller"], [id*="vendor"], [class*="vendor"]')
    if detail:blocks=[soup]
    discovered_types=set()
    if seller['business_type']!='unknown':discovered_types.add(seller['business_type'])
    for block in blocks:
        if block.has_attr('data-seller-id'):
            identifier=block.get('data-seller-id','').strip()
            if identifier:seller['id']=urlsplit(base).netloc.lower()+':seller:'+identifier[:150]
            if block.get('data-seller-name'):seller['name']=block['data-seller-name'][:150]
        declared=block.get('data-business-type') or block.get('data-seller-type')
        if declared in TYPES:
            discovered_types.add(TYPES[declared])
            seller['type_evidence']='공개 판매자 사업자 구분: '+declared
        pairs=[]
        for row in block.select('tr'):
            cells=row.find_all(['th','td'],recursive=False)
            if len(cells)>=2:pairs.append((cells[0].get_text(' ',strip=True),cells[1].get_text(' ',strip=True)))
        for dt in block.select('dt'):
            dd=dt.find_next_sibling('dd')
            if dd:pairs.append((dt.get_text(' ',strip=True),dd.get_text(' ',strip=True)))
        for label,value in pairs:
            if TYPE_LABEL.fullmatch(label) and value in TYPES:
                discovered_types.add(TYPES[value]);seller['type_evidence']=label+' : '+value
            if NAME_LABEL.fullmatch(label) and value:seller['name']=value[:150]
        for link in block.select('a[href]'):
            if re.search(r'판매자\s*정보|사업자\s*정보|판매자\s*상세',link.get_text(' ',strip=True)):
                seller['url']=urljoin(base,link['href']);break
    if len(discovered_types)==1 and not seller.get('ambiguous'):
        seller['business_type']=discovered_types.pop()
    elif len(discovered_types)>1 or seller.get('ambiguous'):
        seller['business_type']='unknown';seller['type_evidence']='판매자 정보가 서로 다르거나 복수 판매자여서 사업자 유형을 확정하지 못했습니다.'
    if not seller.get('ambiguous') and not seller['id'] and seller['url']:
        parts=urlsplit(seller['url'])
        if parts.scheme in ('http','https') and not parts.username and not parts.password:
            seller['id']=parts.netloc.lower()+parts.path.rstrip('/')+('?' + parts.query if parts.query else '')
    # Names are not stable identities: two sellers can share a shop name.
    if not seller['id']:
        seller['id']='unresolved:'+hashlib.sha256(base.encode()).hexdigest()[:20]
    if seller.get('ambiguous'):
        seller['id']='unresolved:'+hashlib.sha256(base.encode()).hexdigest()[:20]
    seller['identity_verified']=not seller['id'].startswith('unresolved:')
    return seller


def catalog_key(url):
    parts=urlsplit(url)
    if parts.hostname in ('www.coupang.com','coupang.com'):
        match=re.search(r'/vp/products/(\d+)',parts.path)
        if match:return 'coupang:'+match.group(1)
    return parts.netloc.lower()+parts.path.rstrip('/')


def summarize(scan):
    products=scan['products']
    image_groups=defaultdict(dict)
    sellers={}
    for product in products:
        seller=product.get('seller') or {'id':'unresolved:'+product['url'],'name':'판매자 확인 불가','business_type':'unknown','identity_verified':False,'type_evidence':''}
        product['seller']=seller
        sid=seller['id']
        if sid not in sellers:
            sellers[sid]={**seller,'product_count':0,'image_checked_products':0,'duplicate_products':0,'duplicate_ratio':0,'duplicate_groups':0,'within_seller_duplicate_products':0,'product_urls':[],'conflict':False}
        summary=sellers[sid]
        if seller['business_type']!=summary['business_type']:
            summary['business_type']='unknown';summary['conflict']=True
            summary['type_evidence']='같은 판매자의 사업자 유형 정보가 일치하지 않습니다.'
        summary['product_count']+=1;summary['product_urls'].append(product['url'])
        summary['image_checked_products']+=any(image.get('informative') for image in product.get('images',[]))
        product.update(duplicate_groups=[],duplicate_peers=[],within_seller_duplicate=False,catalog_shared_photo=False)
        for image in product.get('images',[]):
            if not image.get('informative'):continue
            key=image.get('pixel_sha256') or image.get('sha256')
            if key:image_groups[key][product['url']]={'product':product,'image':image}
    groups=[]
    for key,items in image_groups.items():
        members=list(items.values())
        if len(members)<2:continue
        by_seller=defaultdict(list)
        for member in members:by_seller[member['product']['seller']['id']].append(member)
        for sid,owned in by_seller.items():
            if len(owned)>1:
                for member in owned:member['product']['within_seller_duplicate']=True
        resolved={sid for sid in by_seller if not sid.startswith('unresolved:')}
        if len(resolved)<2:continue
        if len({catalog_key(member['product']['url']) for member in members})<2:
            for member in members:member['product']['catalog_shared_photo']=True
            continue
        group_id='photo-'+key[:20]
        public_members=[]
        for member in members:
            product=member['product'];seller=product['seller']
            if seller['id'].startswith('unresolved:'):continue
            peers=[{'seller_id':other['product']['seller']['id'],'seller_name':other['product']['seller']['name'],'product_url':other['product']['url'],'image_url':other['image']['url']} for other in members if other['product']['seller']['id']!=seller['id'] and not other['product']['seller']['id'].startswith('unresolved:') and catalog_key(other['product']['url'])!=catalog_key(product['url'])]
            if not peers:
                product['catalog_shared_photo']=True
                continue
            product['duplicate_groups'].append(group_id)
            product['duplicate_peers'].extend(peers)
            public_members.append({'seller_id':seller['id'],'seller_name':seller['name'],'product_url':product['url'],'image_url':member['image']['url']})
        groups.append({'id':group_id,'method':'동일 파일 또는 디코딩된 동일 픽셀','seller_count':len(resolved),'product_count':len(public_members),'members':public_members})
    for product in products:
        summary=sellers[product['seller']['id']]
        if product['duplicate_groups']:summary['duplicate_products']+=1
        if product['within_seller_duplicate']:summary['within_seller_duplicate_products']+=1
        # A duplicate image is a lead, never a finding.
        if summary['conflict']:
            product['seller']['observed_business_type']=product['seller']['business_type']
            product['seller']['business_type']='unknown'
            product['seller']['observed_type_evidence']=product['seller'].get('type_evidence','')
            product['seller']['type_evidence']=summary['type_evidence']
        if scan.get('mode')=='seller_duplicates':
            product['state']='candidate' if product['duplicate_groups'] else ('unverified' if not any(image.get('informative') for image in product.get('images',[])) or product.get('errors') else 'below_threshold')
            product['score']=None
            product['reason']='다른 판매자의 상품과 동일 사진 확인' if product['duplicate_groups'] else '동일 사진 근거 미발견 · 정상 판정 아님'
    for summary in sellers.values():
        owned=[product for product in products if product['seller']['id']==summary['id']]
        summary['duplicate_groups']=len({group for product in owned for group in product['duplicate_groups']})
        denominator=summary['image_checked_products']
        summary['duplicate_ratio']=round(summary['duplicate_products']/denominator*100,1) if denominator else None
    ranked=sorted(sellers.values(),key=lambda seller:(seller['duplicate_products'],seller['duplicate_ratio'] or 0,seller['duplicate_groups']),reverse=True)
    scan['counts']['unverified']=sum(product['state'] in ('unverified','partial') or bool(product.get('errors')) for product in products)
    scan['sellers']=ranked;scan['duplicate_image_groups']=groups
    scan['seller_counts']={'all':len(ranked),'individual':sum(s['business_type']=='individual' for s in ranked),'corporation':sum(s['business_type']=='corporation' for s in ranked),'unknown':sum(s['business_type']=='unknown' for s in ranked)}
    if scan.get('mode')=='seller_duplicates':
        scan['counts']['candidates']=sum(p['state']=='candidate' and p['seller']['business_type']=='individual' for p in products)
    ranks={seller['id']:index for index,seller in enumerate(ranked)}
    products.sort(key=lambda product:(ranks[product['seller']['id']],not bool(product['duplicate_groups']),product['name']))
    return scan


def confirmed_bundle(scan):
    groups={}
    for product in scan['products']:
        if product.get('review',{}).get('status')!='confirmed':continue
        seller=product.get('seller',{})
        sid=seller.get('id','unknown')
        group=groups.setdefault(sid,{'seller':seller,'products':[]})
        group['products'].append({'name':product['name'],'category':product['category'],'url':product['url'],
                                  'image_urls':[image['url'] for image in product.get('images',[])],
                                  'duplicate_groups':product.get('duplicate_groups',[]),'review':product['review']})
    return {'scan_id':scan['id'],'site_url':scan['site_url'],'created':scan['created'],
            'confirmation_source':'사용자가 근거와 함께 확인 완료로 기록한 항목. 프로그램이나 기관의 법적 판정이 아닙니다.',
            'product_count':sum(len(group['products']) for group in groups.values()),'sellers':list(groups.values())}
