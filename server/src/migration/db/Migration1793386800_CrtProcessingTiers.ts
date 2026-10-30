import { makeMigrationFromSqlStatements } from './util.ts';

// The legacy performance value predates hardware tiers; it is not an opt-in.
export default makeMigrationFromSqlStatements(
  [
    `UPDATE channel
   SET crt = json_set(crt, '$.processing', 'quality')
   WHERE crt IS NOT NULL AND json_type(crt) = 'object'
     AND (json_extract(crt, '$.processing') IS NULL
       OR json_extract(crt, '$.processing') IN ('standard', 'performance'))`,
  ],
  false,
);
