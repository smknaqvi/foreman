#!/usr/bin/env bash
# Installed by `foreman init --ci --self-hosted`.
# Keeps a Mac that runs a self-hosted GitHub Actions runner awake for one job, and only that job.
# A Mac that falls asleep mid-job loses the runner's connection and the run dies ("the self-hosted runner lost
# communication with the server").
#
#   bash .github/foreman/keep-awake.sh start <minutes>   first step of a job: <minutes> is the job's timeout-minutes
#   bash .github/foreman/keep-awake.sh stop              last step (if: always()): lets the Mac sleep again
#
# `caffeinate -i -s` stops idle sleep (and, on power, system sleep). It ends by itself when the job ends: it
# watches the job's own runner process (Runner.Worker, one per job) and gives up after <minutes> at the most,
# so it's gone even if the job is cancelled before its last step. It can't stop sleep from a closed lid on
# battery, or a dead battery. Not a Mac (no caffeinate): does nothing.
set -euo pipefail

pidfile="${RUNNER_TEMP:-/tmp}/foreman-keep-awake.pid"

case "${1:-}" in
	start)
		minutes="${2:-60}"
		command -v caffeinate >/dev/null || { echo "No caffeinate here (not a Mac): nothing to do."; exit 0; }
		# This job's Runner.Worker: the nearest one above this script.
		pid=$$ worker=
		while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
			case "$(ps -o comm= -p "$pid" 2>/dev/null || true)" in
				*Runner.Worker) worker=$pid; break ;;
			esac
			pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
		done
		args=(-i -s -t $((minutes * 60)))
		[ -n "$worker" ] && args+=(-w "$worker")
		nohup caffeinate "${args[@]}" >/dev/null 2>&1 &
		echo $! > "$pidfile"
		echo "Keeping the Mac awake for this job (caffeinate ${args[*]})${worker:+, until its runner process $worker ends}."
		;;
	stop)
		if [ -f "$pidfile" ]; then
			pid=$(tr -cd '0-9' < "$pidfile")
			# Only if that process is still our caffeinate: once it has ended (its job's process ended or the
			# time ran out), the number may belong to something else.
			if [ -n "$pid" ] && [ "$(ps -p "$pid" -o comm= 2>/dev/null | sed 's#.*/##')" = caffeinate ]; then
				kill "$pid" 2>/dev/null || true
			fi
			rm -f "$pidfile"
		fi
		echo "The Mac may sleep again."
		;;
	*)
		echo "Usage: $0 start <minutes> | stop" >&2
		exit 2
		;;
esac
