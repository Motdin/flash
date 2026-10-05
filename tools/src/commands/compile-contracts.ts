import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { arbArtifactPath, artifactPath } from '../config/registry.js';
import { color, ui } from '../ui/index.js';

const flashSolPath = fileURLToPath(
  new URL('../../../evm/src/FlashLoanExecutor.sol', import.meta.url),
);
const arbSolPath = fileURLToPath(
  new URL('../../../evm/src/poc/MorphoAtomicArbPOC.sol', import.meta.url),
);

export async function compileContracts(): Promise<{
  flashBytecodeSize: number;
  arbBytecodeSize: number;
}> {
  const [flashSource, arbSource] = await Promise.all([
    readFile(flashSolPath, 'utf8'),
    readFile(arbSolPath, 'utf8'),
  ]);

  const input = {
    language: 'Solidity',
    sources: {
      'src/FlashLoanExecutor.sol': { content: flashSource },
      'src/poc/MorphoAtomicArbPOC.sol': { content: arbSource },
    },
    settings: {
      viaIR: true,
      evmVersion: 'shanghai',
      optimizer: {
        enabled: true,
        runs: 200,
      },
      outputSelection: {
        '*': {
          '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: Array<{ severity: string; formattedMessage: string }>;
    contracts?: Record<
      string,
      Record<
        string,
        {
          abi: unknown[];
          evm: {
            bytecode: { object: string };
            deployedBytecode: { object: string };
          };
        }
      >
    >;
  };

  const fatalErrors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (fatalErrors.length > 0) {
    throw new Error(
      `Solidity compilation failed:\n${fatalErrors.map((e) => e.formattedMessage).join('\n')}`,
    );
  }

  const flashCompiled = output.contracts?.['src/FlashLoanExecutor.sol']?.FlashLoanExecutor;
  const arbCompiled = output.contracts?.['src/poc/MorphoAtomicArbPOC.sol']?.MorphoAtomicArbPOC;

  if (!flashCompiled?.evm.bytecode.object || !arbCompiled?.evm.bytecode.object) {
    throw new Error('Gagal menghasilkan bytecode dari solc');
  }

  const flashArtifact = {
    abi: flashCompiled.abi,
    bytecode: {
      object: `0x${flashCompiled.evm.bytecode.object}`,
    },
    deployedBytecode: {
      object: `0x${flashCompiled.evm.deployedBytecode.object}`,
    },
  };

  const arbArtifact = {
    abi: arbCompiled.abi,
    bytecode: {
      object: `0x${arbCompiled.evm.bytecode.object}`,
    },
    deployedBytecode: {
      object: `0x${arbCompiled.evm.deployedBytecode.object}`,
    },
  };

  await mkdir(dirname(artifactPath), { recursive: true });
  await mkdir(dirname(arbArtifactPath), { recursive: true });

  await Promise.all([
    writeFile(artifactPath, `${JSON.stringify(flashArtifact, null, 2)}\n`, 'utf8'),
    writeFile(arbArtifactPath, `${JSON.stringify(arbArtifact, null, 2)}\n`, 'utf8'),
  ]);

  return {
    flashBytecodeSize: flashCompiled.evm.bytecode.object.length / 2,
    arbBytecodeSize: arbCompiled.evm.bytecode.object.length / 2,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  compileContracts()
    .then(({ flashBytecodeSize, arbBytecodeSize }) => {
      ui.success(
        `Compiled ${color.yellow('FlashLoanExecutor.sol')} (${flashBytecodeSize} bytes) -> ${color.cyan(artifactPath)}`,
      );
      ui.success(
        `Compiled ${color.yellow('MorphoAtomicArbPOC.sol')} (${arbBytecodeSize} bytes) -> ${color.cyan(arbArtifactPath)}`,
      );
    })
    .catch((err: unknown) => {
      ui.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    });
}
