#!/usr/bin/env python3
"""Resolve tracked settings and hash protected inventories. Never load credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import re


def settings(directory, machine, project):
    defaults = json.loads((Path(directory) / 'defaults.json').read_text())
    computers = json.loads((Path(directory) / 'computers.json').read_text())
    if machine not in computers or not re.fullmatch(r'[\w.-]+/[\w.-]+', project):
        raise ValueError('Unknown computer or invalid project')
    override = computers[machine]
    project_override = override.get('projects', {}).get(project, {})
    result = {**defaults, **{key: value for key, value in override.items() if key != 'projects'}, **project_override}
    result['env'] = {**defaults.get('env', {}), **override.get('env', {}), **project_override.get('env', {})}
    if project == 'pyrycode/pyrycode-desktop':
        result['env']['PYRY_E2E_DISPLAY'] = 'private'
    if result['version'] != 1 or set(result['env']) - {'PW_WORKERS', 'PYRY_E2E_DISPLAY'}:
        raise ValueError('Invalid tracked runtime settings')
    return result


def record(image, tools, gates, agents, test_daemon):
    if not re.fullmatch('[a-f0-9]{40}', agents) or not re.fullmatch('[a-f0-9]{40}', test_daemon):
        raise ValueError('Runtime source revisions must be exact')
    if not all(isinstance(value, str) and value.strip() and value.strip() not in {'latest', 'unknown'} for value in [image, tools, gates]):
        raise ValueError('Exact runtime inventories are required')
    return {'image': hashlib.sha256(image.encode()).hexdigest(), 'tools': hashlib.sha256(tools.encode()).hexdigest(),
            'gates': hashlib.sha256(gates.encode()).hexdigest(), 'agents': agents, 'testDaemon': test_daemon}


def save(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.parent.is_symlink() or path.parent.stat().st_mode & 0o077:
        raise ValueError('Output directory must be private')
    with path.open('x') as stream:
        path.chmod(0o600)
        stream.write(json.dumps(value, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    resolve = commands.add_parser('settings')
    resolve.add_argument('machine')
    resolve.add_argument('project')
    resolve.add_argument('output')
    build = commands.add_parser('record')
    build.add_argument('inventories')
    build.add_argument('agents')
    build.add_argument('test_daemon')
    build.add_argument('output')
    args = parser.parse_args()
    try:
        if args.command == 'settings':
            value = settings(Path(__file__).resolve().parents[1] / 'fleet-runtime', args.machine, args.project)
        else:
            directory = Path(args.inventories)
            value = record((directory / 'image.txt').read_text(), (directory / 'tools.txt').read_text(),
                           (directory / 'gates.txt').read_text(), args.agents, args.test_daemon)
        save(args.output, value)
    except Exception:
        raise SystemExit('Runtime preparation refused. Inspect the protected input files and private destination.') from None
