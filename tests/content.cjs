const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const root = path.join(__dirname, '..');
const registry = fs.readFileSync(path.join(root, 'google-apps.js'), 'utf8');
const behavior = fs.readFileSync(path.join(root, 'typing-behavior.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

// Protocol regressions only; real Google models are verified separately in Chrome.
function fixture(app, options = {}) {
  const listeners = new Map(), messages = [], handlers = [];
  let rangeRestores = 0;
  const doc = {
    addEventListener(name, fn) { const list = listeners.get(name) || []; list.push(fn); listeners.set(name, list); },
    getSelection: () => ({ rangeCount: 0, removeAllRanges() { rangeRestores++; }, addRange() { rangeRestores++; } }),
    getElementById: id => id === 'field-label' ? { textContent: '表单说明' } : null
  };
  class Element {
    constructor(attrs = {}) { this.attrs = attrs; this.tagName = 'DIV'; this.isConnected = true; this.ownerDocument = doc; this.isContentEditable = true; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    contains(node) { return node === this; }
    focus() { this.ownerDocument.activeElement = this; }
    matches(selector) { return this.isBridge && selector.includes('docs-texteventtarget-iframe'); }
    closest(selector) {
      if (selector.includes('contenteditable') && this.isContentEditable && !this.isBridge) return this;
      if (this.id === 'waffle-rich-text-editor' && selector.includes(this.id)) return this;
      return null;
    }
    getBoundingClientRect() { return this.editing ? {width:100,height:20,bottom:120} : {width:0,height:20,bottom:-9998}; }
  }
  class Input extends Element {
    constructor() { super(); this.type = 'text'; this.tagName = 'INPUT'; this.value = ''; this.selectionStart = 1; this.selectionEnd = 2; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  class Textarea extends Input {}
  const editor = options.input ? new Input() : new Element(options.attrs || {});
  const inner = { activeElement: null, addEventListener() {} };
  const bridge = new Element(); bridge.ownerDocument = inner;
  const frame = new Element(); frame.isBridge = true;
  frame.contentDocument = { querySelector: () => options.noBridge ? null : bridge, addEventListener() {} };
  const box = { value: 'A1' };
  if (app === 'sheets') { editor.id = 'waffle-rich-text-editor'; editor.attrs.role = 'combobox'; editor.editing = options.editing === true; if(editor.editing) editor.attrs['aria-label'] = box.value; }
  doc.activeElement = ['docs','slides'].includes(app) ? frame : editor;
  doc.querySelector = selector => {
    if (selector === '#t-name-box') return box;
    if (selector === '#waffle-rich-text-editor') return editor;
    if (selector === '.docs-texteventtarget-iframe') return frame;
    if (selector === '.docs-text-selectionhandle') return options.noHandles ? null : {};
    return null;
  };
  const urls = {docs:'https://docs.google.com/document/d/test/edit',sheets:'https://docs.google.com/spreadsheets/d/test/edit',slides:'https://docs.google.com/presentation/d/test/edit',gmail:'https://mail.google.com/mail/u/0',forms:'https://docs.google.com/forms/d/test/edit',keep:'https://keep.google.com/u/0',drive:'https://drive.google.com/drive/u/0'};
  const location = new URL(urls[app]);
  const context = vm.createContext({document:doc, location, Element, HTMLInputElement:Input, HTMLTextAreaElement:Textarea,
    AbortController, URL, crypto:webcrypto,setTimeout,clearTimeout,
    chrome:{runtime:{sendMessage:async m=>messages.push(m),onMessage:{addListener:fn=>handlers.push(fn),removeListener:fn=>handlers.splice(handlers.indexOf(fn),1)}}}});
  vm.runInContext(registry + '\n' + behavior + '\n' + source, context);
  const target = () => messages.filter(m=>m.type==='HT_TARGET').at(-1);
  const send = (type,details={}) => { let result; handlers[0]({...details,type,targetId:target()?.targetId,runId:'run-1'},{},r=>result=r); return result; };
  const fire = (name, node=editor, extra={}) => (listeners.get(name)||[]).forEach(fn=>fn({composedPath:()=>[node],target:node,...extra}));
  return {editor,box,doc,inner,bridge,location,context,messages,target,send,fire,rangeRestores:()=>rangeRestores};
}

const results=[];
function test(name,fn) { fn(); results.push(name); console.log('PASS '+name); }
test('Sheets combobox outside the viewport still requires Enter',()=>{
  const f=fixture('sheets'); assert.equal(f.target().cell,'A1'); assert.equal(f.send('HT_NATIVE_BEGIN').enterEdit,true);
  assert.equal(f.send('HT_NATIVE_READY').ok,false);
  f.editor.editing=true; f.editor.attrs['aria-label']='A1'; assert.equal(f.send('HT_NATIVE_READY').ok,true);
});
test('Sheets editing state does not restore a bridge DOM Range',()=>{
  const f=fixture('sheets',{editing:true}); assert.equal(f.send('HT_NATIVE_BEGIN').enterEdit,false);
  assert.equal(f.send('HT_FOCUS').ok,true); assert.equal(f.rangeRestores(),0);
});
test('Sheets keyboard selection updates the cell target token',()=>{
  const f=fixture('sheets'); const first=f.target().targetId; f.box.value='A2'; f.fire('keyup');
  assert.equal(f.target().cell,'A2'); assert.notEqual(f.target().targetId,first);
});
test('Sheets refuses a cell changed during a locked task',()=>{
  const f=fixture('sheets',{editing:true});f.send('HT_NATIVE_BEGIN');f.box.value='B1';assert.equal(f.send('HT_FOCUS').ok,false);
});
test('Sheets refuses a multiple-cell selection',()=>{
  const f=fixture('sheets');f.box.value='A1:B2';f.fire('keyup');assert.equal(f.messages.at(-1).type,'HT_NOTICE');
  assert.equal(f.send('HT_NATIVE_BEGIN').ok,false);
});
test('Keep title remains single-line when aria-label is removed',()=>{
  const f=fixture('keep',{attrs:{role:'textbox'}});assert.equal(f.target().multiline,false);assert.equal(f.target().label,'Google Keep · 标题');
});
test('Keep note body is multiline and has a readable field name',()=>{
  const f=fixture('keep',{attrs:{role:'combobox'}});assert.equal(f.target().multiline,true);assert.equal(f.target().label,'Google Keep · 记事');
});
test('Forms accessible label is read from aria-labelledby',()=>{
  const f=fixture('forms',{attrs:{'aria-labelledby':'field-label'}});assert.equal(f.target().label,'Google Forms · 表单说明');
});
test('Gmail input restores the saved selection after sidebar focus',()=>{
  const f=fixture('gmail',{input:true});assert.equal(f.target().multiline,false);f.doc.activeElement={};assert.equal(f.send('HT_NATIVE_BEGIN').ok,true);
  assert.equal(f.doc.activeElement,f.editor);assert.equal(f.editor.selectionStart,1);assert.equal(f.editor.selectionEnd,2);
});
test('Native task locks the target and unlocks on end',()=>{
  const f=fixture('gmail',{input:true});const token=f.target().targetId;f.send('HT_NATIVE_BEGIN');f.send('HT_ARM');assert.equal(f.target().targetId,token);
  f.send('HT_NATIVE_END');assert.equal(f.send('HT_ARM').ok,true);assert.equal(f.send('HT_FOCUS').ok,false);
});
test('Trusted page navigation cancels native typing',()=>{
  const f=fixture('drive',{input:true});f.send('HT_NATIVE_BEGIN');f.fire('keydown',f.editor,{key:'ArrowLeft',isTrusted:true});assert.equal(f.messages.at(-1).type,'HT_NATIVE_CANCEL');
});
test('Docs restores the editor bridge without changing its DOM selection',()=>{
  const f=fixture('docs');assert.equal(f.send('HT_NATIVE_BEGIN').ok,true);assert.equal(f.inner.activeElement,f.bridge);assert.equal(f.rangeRestores(),0);
});
test('Docs reports a missing editor instead of starting input',()=>{
  const f=fixture('docs',{noBridge:true});assert.equal(f.send('HT_NATIVE_BEGIN').ok,false);assert.equal(f.send('HT_ARM').ok,true);
});
test('Slides refuses text input after leaving text editing mode',()=>{
  const f=fixture('slides');assert.equal(f.target().kind,'google-slides');
  const g=fixture('slides',{noHandles:true});assert.equal(g.target(),undefined);assert.equal(g.send('HT_NATIVE_BEGIN').ok,false);
});
test('Changing the current document invalidates its saved input target',()=>{
  const f=fixture('docs');f.location.pathname='/document/d/another/edit';assert.equal(f.send('HT_NATIVE_BEGIN').ok,false);
});
test('Google input preflight rejects a temporary letter beyond the webpage length limit',()=>{
  const f=fixture('gmail',{input:true});f.editor.value='123';f.editor.maxLength=3;f.editor.selectionStart=f.editor.selectionEnd=3;f.fire('select');
  assert.equal(f.send('HT_NATIVE_BEGIN').ok,true);assert.equal(f.send('HT_NATIVE_BEFORE',{text:'a'}).ok,false);assert.equal(f.editor.value,'123');
});
console.log(results.length+' / '+results.length+' passed');
