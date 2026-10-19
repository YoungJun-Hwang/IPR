"""Run a real, bounded scan and always write a factual report (including failures)."""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import catalog
from app.main import fetch_public


def run(config, output):
    body=catalog.ScanInput(**config,mode='seller_duplicates')
    with tempfile.TemporaryDirectory(prefix='ipr-batch-') as directory:
        db=Path(directory)/'scan.sqlite3'
        created=catalog.start_scan(db,body,fetch_public)
        while True:
            report=catalog.get_scan(db,created['id'])
            if report['status'] not in ('running','queued'):break
            time.sleep(.5)
        report.update(schema='ipr.scan.v1',demo=False,execution='github_actions' if __import__('os').environ.get('GITHUB_ACTIONS')=='true' else 'local_cli')
        import os
        if os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('IPR_PUBLIC_REPOSITORY')!='false':
            report.update(products=[],sellers=[],duplicate_image_groups=[],references=[],privacy_redacted=True)
            report['warnings'].append('공개 저장소의 Actions 산출물이므로 판매자·상품 원자료를 포함하지 않습니다. 실제 목록은 로컬 실행 또는 브라우저 수집 파일로 확인하세요.')
        output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'status':report['status'],'stage':report['stage'],'counts':report['counts']},ensure_ascii=False))
        return 0 if report['status']=='complete' else 2


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',default='requests/coupang.json')
    parser.add_argument('--output',default='artifacts/real-scan.json')
    args=parser.parse_args()
    config=json.loads(Path(args.config).read_text(encoding='utf-8'))
    # Mode is fixed so workflow inputs cannot request a different or unbounded task.
    config.pop('mode',None)
    try:
        code=run(config,Path(args.output))
    except (ValueError,TypeError) as error:
        import uuid
        from datetime import datetime,timezone
        failure={'schema':'ipr.scan.v1','id':uuid.uuid4().hex,'created':datetime.now(timezone.utc).isoformat(),'site_url':config.get('site_url',''),'mode':'seller_duplicates','demo':False,'status':'failed','stage':'입력 검증 실패: '+str(error),'counts':{'discovered':0,'checked':0,'candidates':0,'unverified':0},'products':[],'warnings':[]}
        destination=Path(args.output);destination.parent.mkdir(parents=True,exist_ok=True);destination.write_text(json.dumps(failure,ensure_ascii=False),encoding='utf-8')
        code=2
    raise SystemExit(code)
