"""Closed final-close refusal evidence; never a cleanup verdict."""
import importlib.util,json,pathlib,unittest
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hung_closed',HERE/'collect-spec-hung-cleanup.py')
hung=importlib.util.module_from_spec(spec);spec.loader.exec_module(hung)
SCHEMA=json.loads((HERE/'native-closed-trace-schema.json').read_text())
BASE={'schemaVersion':2,'source':'native','pid':123,'record':0,'operationSeq':0,'phase':'CaptureStarted','droppedBefore':0,'emittedBefore':0,'suppressedBefore':0,'overflow':False}
def data(row):
    rows=[BASE,{**BASE,'record':1,'emittedBefore':1,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'enrollment-proof','terminalCleanupOk':False,**row},{**BASE,'record':2,'emittedBefore':2,'phase':'TerminalCleanupCheckpoint','terminalCleanupStage':'shutdown-joins','terminalCleanupOk':False}]
    return b''.join((json.dumps(r,separators=(',',':'))+'\n').encode() for r in rows)
class ClosedTerminal(unittest.TestCase):
    def test_every_closed_reason_survives_original_collector(self):
        for reason in SCHEMA['fields']['terminalEnrollmentRefusal']['enum']:
            with self.subTest(reason=reason):
                rows,issues=hung.inspect(data({'terminalEnrollmentRefusal':reason}),SCHEMA)
                self.assertEqual(issues,set());self.assertEqual(rows[1]['terminalEnrollmentRefusal'],reason)
                self.assertFalse(rows[-1]['terminalCleanupOk'])
    def test_watermarks_and_counts_are_exact_non_authority(self):
        for reason,counts in [('enrollment-watermark',[7,9]),('ledger-target-count',[2,1]),('registry-reservations',[1,0]),('enrollment-realm-pending',[2**53-1,0])]:
            rows,issues=hung.inspect(data({'terminalEnrollmentRefusal':reason,'terminalProofCounts':counts}),SCHEMA)
            self.assertEqual(issues,set());self.assertEqual(rows[1]['terminalProofCounts'],counts)
            self.assertFalse(rows[1]['terminalCleanupOk'])
    def test_unknown_reason_context_and_payload_never_archived(self):
        for edit in [{'terminalEnrollmentRefusal':'SECRET_CANARY'}, {'terminalEnrollmentRefusal':{}}, {'terminalCleanupOk':True}, {'terminalCleanupStage':'task-proof'}, {'phase':'CaptureStarted'}, {'message':'SECRET_CANARY'}, {'terminalProofCounts':[True,0]}, {'terminalProofCounts':[-1,0]}, {'terminalProofCounts':[2**53,0]}, {'terminalProofCounts':[1]}, {'terminalProofCounts':[1,0,0]}]:
            with self.subTest(edit=edit):
                rows,issues=hung.inspect(data({'terminalEnrollmentRefusal':'enrollment-watermark',**edit}),SCHEMA)
                self.assertIn('invalid-record',issues)
                self.assertFalse(any(r.get('record')==1 for r in rows))
    def test_counts_require_appropriate_closed_reason(self):
        for row in [{'terminalProofCounts':[1,0]},{'terminalEnrollmentRefusal':'ledger-command-contract','terminalProofCounts':[1,0]}]:
            self.assertIn('invalid-record',hung.inspect(data(row),SCHEMA)[1])
    def test_no_new_fields_preserves_original_rows(self):
        rows,issues=hung.inspect(data({}),SCHEMA);self.assertEqual(issues,set());self.assertEqual(len(rows),3)
    def test_loss_stays_incomplete(self):
        rows,issues=hung.inspect(data({'terminalEnrollmentRefusal':'enrollment-watermark','droppedBefore':1}),SCHEMA)
        self.assertIn('capture-loss',issues)
if __name__=='__main__':unittest.main()
