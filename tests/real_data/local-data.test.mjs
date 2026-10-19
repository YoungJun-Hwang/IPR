import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../app/static/local-data.js',import.meta.url),'utf8');
const window={};vm.runInNewContext(source,{window,URL});
const summarize=window.IPR_LOCAL_REPORTS.summarize;
function product(id,seller,photo,type='individual',url){return {url:url||'https://store.example/products/'+id,name:id,category:'가방',seller:{id:seller,name:seller,business_type:type,identity_verified:true,type_evidence:'사업자 구분',evidence_url:'https://store.example/seller/'+seller},images:[{url:'https://cdn.example/'+photo,pixel_sha256:photo,sha256:photo,informative:true}],errors:[],review:{status:'unreviewed'}};}
function report(products){return {products,counts:{discovered:products.length}};}
test('local actual-data ranking counts each product once and does not auto-confirm',()=>{
 const one=product('1','A','photo1');one.images.push(one.images[0]);
 const data=summarize(report([one,product('2','A','photo2'),product('3','B','photo1'),product('4','C','photo2','corporation')]));
 assert.equal(data.sellers[0].id,'A');assert.equal(data.sellers[0].duplicate_products,2);assert.equal(data.counts.candidates,3);
 assert.ok(data.products.every(product=>product.review.status==='unreviewed'));
});
test('Coupang shared-catalog images never become cross-catalog leads',()=>{
 const data=summarize(report([product('1','A','p','individual','https://www.coupang.com/vp/products/100?vendorItemId=1'),product('2','B','p','individual','https://www.coupang.com/vp/products/100?vendorItemId=2')]));
 assert.equal(data.counts.candidates,0);assert.ok(data.products.every(product=>product.catalog_shared_photo));
});
test('unresolved identity, low-information images and failed images remain unverified',()=>{
 const one=product('1','unresolved:A','p');one.seller.identity_verified=false;
 const two=product('2','B','p');two.images[0].informative=false;
 const three=product('3','C','q');three.images=[];three.errors=['failed'];
 const data=summarize(report([one,two,three]));assert.equal(data.counts.candidates,0);assert.equal(data.counts.unverified,2);
});
