#!/usr/bin/env node
import { run } from "../cli.js";

void run("dbshape", process.argv.slice(2));
