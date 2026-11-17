import {expect,it} from 'vitest'
import {validateMcpPluginMembers} from './package-mcp-plugin.ts'
const members=['lib/index.js','lib/host.js','lib/agent.js','lib/browser.js','lib/ui.js','lib/client.js','cordis.patch.yml','LICENSE'].map(file=>'package/'+file)
it('accepts a self-contained plugin with all component entries and license',()=>{expect(()=>validateMcpPluginMembers(members)).not.toThrow()})
it('rejects traversal outside the package',()=>{expect(()=>validateMcpPluginMembers([...members,'package/../../../other'])).toThrow('path outside')})
it('requires every component, browser artifact, configuration and license',()=>{for(const entry of members)expect(()=>validateMcpPluginMembers(members.filter(file=>file!==entry))).toThrow('missing')})
it('rejects separately packed internal workspaces',()=>{expect(()=>validateMcpPluginMembers([...members,'package/node_modules/@j-show/mcp-proxy-protocol/package.json'])).toThrow('Internal package')})
