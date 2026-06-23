# KARMA ZK circuits — Stellar ZK track (T4 + T1.1)
#
# `make toolchain` installs circom + snarkjs locally (idempotent).
# `make dummy`      runs the toolchain-validation pipeline (multiplier circuit).
# `make credential` runs the AgentCredentialProof end-to-end pipeline (T4).
# `make rep-agg`    runs the ReputationAggregationProof end-to-end pipeline (T1.1).
# `make all`        does every circuit pipeline.

SHELL := /usr/bin/env bash

# pot16 prepare-phase2 (T1.1) is heavyweight. Default Node heap is enough but allow
# operators to raise it; pot13 (T4) needs no extra room.
NODE_OPTS ?= --max-old-space-size=8192

.PHONY: all toolchain dummy credential rep-agg clean

all: toolchain dummy credential rep-agg

toolchain:
	@bash scripts/install-toolchain.sh

dummy: toolchain
	@node test/dummy_multiplier.test.mjs

credential: toolchain
	@node test/agent_credential.test.mjs

rep-agg: toolchain
	@NODE_OPTIONS="$(NODE_OPTS)" node test/reputation_aggregation.test.mjs

clean:
	@rm -rf build/
