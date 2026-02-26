
import { exit } from 'process';

// System function to finish the task
(global as any).FINISH = (message: string) => {
    console.log('__ACN_FINISH_START__' + JSON.stringify(message) + '__ACN_FINISH_END__');
    exit(0);
};

// Type definition for TypeScript (doesn't affect runtime but good for documentation if we generated d.ts)
declare global {
    function FINISH(message: string): void;
}
