import type {Observation} from '../src/core/types';
export const entry=(overrides:Partial<Observation>={}):Observation=>({id:'turn-1',source:'codex',connection:'conn-1',requestId:'turn-1',time:Date.now(),requested:'gpt-6-astra',requestEvidence:'wire',candidates:[],transport:'proxy',state:'pending',special:false,...overrides});
