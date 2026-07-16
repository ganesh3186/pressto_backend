import {RegionRepository} from './src/repositories';
import {presstoBackendApplication} from './src/application';

async function test() {
  const app = new presstoBackendApplication();
  await app.boot();
  
  const repo = await app.getRepository(RegionRepository);
  const def = (repo as any).entityClass.definition;
  console.log('Properties:', Object.keys(def.properties));
}
test().catch(console.error);
