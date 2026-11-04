"""Mirror the existing typed native producer; never reconstruct discarded CI rows."""
import copy,importlib.util,json,pathlib,unittest
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('capture',HERE/'collect-spec-hung-cleanup.py')
capture=importlib.util.module_from_spec(spec);spec.loader.exec_module(capture)
SCHEMA=json.loads((HERE/'native-closed-trace-schema.json').read_text())
BASE={'schemaVersion':2,'source':'native','pid':123,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False}
COUNTED={'integrity-lost','input-debt','object-debt','outstanding-commands'}
def payload(edit):
    rows=[BASE,{**BASE,'record':1,'emittedBefore':1,'operationSeq':17,'generation':1,'phase':'ObserveInitialAcquisition',**edit},{**BASE,'record':2,'emittedBefore':2,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'shutdown-joins','terminalCleanupOk':True}]
    return b''.join((json.dumps(row,separators=(',',':'))+'\n').encode() for row in rows)
class ObserveInitial(unittest.TestCase):
    def test_original_missing_phase_is_a_real_schema_incompatibility(self):
        old=copy.deepcopy(SCHEMA);old['fields']['phase']['enum'].remove('ObserveInitialAcquisition')
        self.assertIn('invalid-record',capture.inspect(payload({'initialSample':1}),old)[1])
    def test_both_initial_samples_survive_unchanged(self):
        for sample in [1,2]:
            rows,issues=capture.inspect(payload({'initialSample':sample}),SCHEMA)
            self.assertFalse(issues);self.assertEqual(rows[1]['initialSample'],sample)
    def test_every_typed_prefix_and_bounded_counts(self):
        for check in ['before-yield','after-yield']:
            for reason in SCHEMA['fields']['prefixRefusal']['enum']:
                edit={'prefixCheck':check,'prefixRefusal':reason}
                if reason in COUNTED:edit.update(prefixDebt=[0,1,65535],prefixDebtCapped=False)
                rows,issues=capture.inspect(payload(edit),SCHEMA)
                self.assertFalse(issues,(check,reason,issues));self.assertEqual(rows[1]['prefixRefusal'],reason)
        self.assertFalse(capture.inspect(payload({'initialSample':2,'prefixCheck':'after-yield','prefixRefusal':'object-debt','prefixDebt':[0,65535,1],'prefixDebtCapped':True}),SCHEMA)[1])
    def test_closed_keys_types_and_phase_constraints(self):
        for edit in [{},{'initialSample':0},{'initialSample':3},{'initialSample':True},{'initialSample':'SECRET'}, {'initialSample':1,'message':'SECRET'}, {'initialSample':1,'phase':'CaptureStarted'}, {'initialSample':1,'terminalCleanupOk':True}, {'prefixCheck':'before-yield'}, {'prefixRefusal':'owner-mismatch'}, {'prefixCheck':'SECRET','prefixRefusal':'owner-mismatch'}, {'prefixCheck':'before-yield','prefixRefusal':'SECRET'}]:
            rows,issues=capture.inspect(payload(edit),SCHEMA)
            self.assertIn('invalid-record',issues,edit);self.assertFalse(any(row.get('record')==1 for row in rows));self.assertNotIn('SECRET',json.dumps(rows))
    def test_debt_presence_and_limits_are_exact(self):
        base={'prefixCheck':'before-yield','prefixRefusal':'input-debt','prefixDebt':[1,0,0],'prefixDebtCapped':False}
        bad=[{**base,'prefixRefusal':'ledger-unavailable'},{**base,'prefixDebt':[-1,0,0]},{**base,'prefixDebt':[65536,0,0]},{**base,'prefixDebt':[True,0,0]},{**base,'prefixDebt':[1,0]},{**base,'prefixDebtCapped':True},{**base,'prefixDebtCapped':1}]
        bad += [{key:value for key,value in base.items() if key!=missing} for missing in ['prefixDebt','prefixDebtCapped']]
        for edit in bad:self.assertIn('invalid-record',capture.inspect(payload(edit),SCHEMA)[1],edit)
    def test_loss_remains_unknown_and_original_rows_are_unchanged(self):
        self.assertIn('capture-loss',capture.inspect(payload({'initialSample':1,'droppedBefore':1}),SCHEMA)[1])
        rows,issues=capture.inspect(payload({'initialSample':1}),SCHEMA)
        self.assertEqual(rows[0],BASE);self.assertFalse(issues)
if __name__=='__main__':unittest.main()
