import assert from 'node:assert/strict';
import {JsonDistributionRepository} from '../../lib/distribution-repository.mjs';
import {createMarketPublication,captureEditorialImage} from '../../lib/market-publication.mjs';
import {png,response,weeklyArticle,dataArticle} from '../fixtures/editorial-pages.mjs';
assert.equal(process.env.JSON_STORE_DIRECTORY,'.runtime-audit','Seed only the isolated audit store');
const repository=new JsonDistributionRepository();
for(const [product,article] of [['weekly-calendar',weeklyArticle()],['data-update',dataArticle()]]){
 article.title='QA FIXTURE — '+article.title;
 await createMarketPublication({repository,product,slug:article.slug,article,communityDocument:{},posterModel:{canvas:{width:1200,height:675}},sourceManifest:[],now:()=> '2026-08-21T00:00:00.000Z'});
 await captureEditorialImage({repository,product,slug:article.slug,publicOrigin:'https://academy.example',allowedOrigins:['https://academy.example'],now:()=> '2026-08-21T00:00:00.001Z',fetchImpl:async(url)=>response(png(),{url})});
}
console.log('Two isolated editorial fixtures saved');
