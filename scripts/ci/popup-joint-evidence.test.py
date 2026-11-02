"""Closed evidence controls only; no socket or browser."""
import importlib.util,json,pathlib,sys,unittest
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('evidence',pathlib.Path(__file__).with_name('popup-joint-evidence.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Tests(unittest.TestCase):
 def data(self,changes=None):
  rows=[{'kind':'connection','monotonicUs':0,'role':'native','connectionOrdinal':1},{'kind':'connection','monotonicUs':1,'role':'playwright','connectionOrdinal':2}]
  lines=[json.dumps(r,separators=(',',':')).encode()+b'\n' for r in rows]
  summary={'kind':'summary','monotonicUs':2,'metadataComplete':True,'connections':2,'pendingCount':0,'discardedRecords':0,'unknownRoles':0,'recordsWritten':3,'bytesBeforeSummary':sum(map(len,lines))}
  for k in m.relay.BOOLS:
   if k.endswith('Overflow') or k.endswith('Capped') or k in {'transportError','invalidJson','correlationLost'}:summary[k]=False
  summary.update(changes or {});return b''.join(lines)+json.dumps(summary,separators=(',',':')).encode()+b'\n'
 def test_complete(self):self.assertTrue(m.validate(self.data())[1])
 def test_incomplete_flags(self):
  for k,v in [('transportError',True),('pendingCount',1),('unknownRoles',1),('metadataComplete',False),('bytesCapped',True)]:self.assertFalse(m.validate(self.data({k:v}))[1])
 def test_rejected(self):
  for data in [self.data()[:-1],self.data({'secret':'raw-url'}),self.data({'connections':True}),self.data({'monotonicUs':0}),self.data({'recordsWritten':9}),self.data({'bytesBeforeSummary':1}),b'x'*262145,self.data().replace(b'"kind":"connection"',b'"kind":"connection","kind":"role"',1)]:
   with self.assertRaises((AssertionError,ValueError)):m.validate(data)
 def test_missing_role(self):self.assertFalse(m.validate(self.data().replace(b'"playwright"',b'"native"    '))[1])
if __name__=='__main__':unittest.main()
