why we arent using kubernetes for docker orchestration ?

answer :- the control-plane latency is too high.
the Message Queue (Redis + BullMQ) + Worker service concurrency limit is the orchestrator.

-> the worker serive is a js code or program that will act as an orchestration, it will receive the input from the node.js api and it will pin up the docker images based on the programming language and it will run the code and look over the output metrics of the code and benchmarks the code.
->Worker Engine (Node.js)  automates Docker execution, measures runtime, compares stdout against test cases, and calculates the 0–100 score.
-> so we have a worker virtual machine, and we put a concurrency limit there so that maximum n amount of docker containers get spinned. 

-> once the server gets the submitted json via  the node.js api then the worker pulls each code strip and excutes them one by one. 

-> even at scale instead of switching to k8s for orchestration we just scale then the number virtual machines and each vm workers will pull from sql/redis queue. 


what is cgroup ?
-> in linux cgroups are control groups that control the amount of resources programms are using, resources are CPU, RAM, BANDWIDTH, STORAGE...

->