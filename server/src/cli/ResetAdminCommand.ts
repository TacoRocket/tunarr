import type { CommandModule } from 'yargs';
import { globalOptions } from '../globals.ts';
import { AdminCredentials } from '../services/AdminCredentials.ts';

export const ResetAdminCommand: CommandModule = {
  command: 'reset-admin',
  describe: 'Generate a new password for the saved Tunarr administrator',
  handler: async () => {
    try {
      const credentials = new AdminCredentials(
        globalOptions().databaseDirectory,
      );
      await credentials.load();
      const { username, password } = await credentials.resetPassword();
      process.stdout.write(
        `Administrator: ${username}\nNew password: ${password}\nRestart Tunarr to use this password.\n`,
      );
    } catch (error) {
      process.exitCode = 1;
      throw error;
    }
  },
};
