import importlib.util
import json
from pathlib import Path

from app import catalog
from test_catalog import Deferred,fake_store


def load():
    spec=importlib.util.spec_from_file_location('real_runner',Path(__file__).parents[1]/'scripts/run-real-scan.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def synchronous(monkeypatch):
    original=catalog.start_scan
    monkeypatch.setattr(catalog,'POOL',Deferred())
    def start(path,body,fetcher):
        created=original(path,body,fetcher)
        catalog.run_scan(path,created['id'],body,[],fetcher,delay=0)
        return created
    monkeypatch.setattr(catalog,'start_scan',start)


def test_runner_writes_actual_failure_without_sample(tmp_path,monkeypatch):
    runner=load();synchronous(monkeypatch)
    def denied(*args):raise ValueError('HTTP 403')
    monkeypatch.setattr(runner,'fetch_public',denied)
    target=tmp_path/'report.json'
    code=runner.run({'site_url':'https://www.coupang.com/'},target)
    data=json.loads(target.read_text())
    assert code==2
    assert data['schema']=='ipr.scan.v1'
    assert data['demo'] is False
    assert data['status']=='failed'
    assert data['products']==[]
    assert '403' in data['stage']


def test_runner_uses_actual_collector_output(tmp_path,monkeypatch):
    runner=load();synchronous(monkeypatch)
    monkeypatch.setattr(runner,'fetch_public',fake_store)
    target=tmp_path/'report.json'
    assert runner.run({'site_url':'https://store.example/'},target)==0
    data=json.loads(target.read_text())
    assert data['counts']['checked']==3
    assert data['products']
    assert not data['demo']
