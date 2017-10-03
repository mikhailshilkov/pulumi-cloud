// Copyright 2016-2017, Pulumi Corporation.  All rights reserved.

import * as aws from "@pulumi/aws";
import * as cloud from "@pulumi/cloud";
import * as pulumi from "pulumi";
import { ecsClusterARN, ecsClusterSubnets, ecsClusterVpcId } from "./config";

type ECSKernelCapability = "ALL" | "AUDIT_CONTROL" | "AUDIT_WRITE" | "BLOCK_SUSPEND" | "CHOWN" | "DAC_OVERRIDE" |
    "DAC_READ_SEARCH" | "FOWNER" | "FSETID" | "IPC_LOCK" | "IPC_OWNER" | "KILL" | "LEASE" | "LINUX_IMMUTABLE" |
    "MAC_ADMIN" | "MAC_OVERRIDE" | "MKNOD" | "NET_ADMIN" | "NET_BIND_SERVICE" | "NET_BROADCAST" | "NET_RAW" |
    "SETFCAP" | "SETGID" | "SETPCAP" | "SETUID" | "SYS_ADMIN" | "SYS_BOOT" | "SYS_CHROOT" | "SYS_MODULE" |
    "SYS_NICE" | "SYS_PACCT" | "SYS_PTRACE" | "SYS_RAWIO" | "SYS_RESOURCE" | "SYS_TIME" | "SYS_TTY_CONFIG" |
    "SYSLOG" | "WAKE_ALARM";

type ECSLogDriver = "json-file" | "syslog" | "journald" | "gelf" | "fluentd" | "awslogs" | "splunk";

type ECSUlimitName = "core" | "cpu" | "data" | "fsize" | "locks" | "memlock" | "msgqueue" | "nice" |
    "nofile" | "nproc" | "rss" | "rtprio" | "rttime" | "sigpending" | "stack";

interface ECSContainerDefinition {
    command?: string[];
    cpu?: number;
    disableNetworking?: boolean;
    dnsSearchDomains?: boolean;
    dnsServers?: string[];
    dockerLabels?: { [label: string]: string };
    dockerSecurityOptions?: string[];
    entryPoint?: string[];
    environment?: { name: string; value: string; }[];
    essential?: boolean;
    extraHosts?: { hostname: string; ipAddress: string }[];
    hostname?: string;
    image?: string;
    links?: string[];
    linuxParameters?: { capabilities?: { add?: ECSKernelCapability[]; drop?: ECSKernelCapability[] } };
    logConfiguration?: { logDriver: ECSLogDriver; options?: { [key: string]: string } };
    memory?: number;
    memoryReservation?: number;
    mountPoints?: {containerPath?: string; readOnly?: boolean; sourceVolume?: string}[];
    name: string;
    portMappings?: {containerPort?: number; hostPort?: number; protocol?: string; }[];
    privileged?: boolean;
    readonlyRootFilesystem?: boolean;
    ulimits?: {name: ECSUlimitName; hardLimit: number; softLimit: number}[];
    user?: string;
    volumesFrom?: {sourceContainer?: string; readOnly?: boolean}[];
    workingDirectory?: string;
}

// The shared Load Balancer management role used across all Services.
let serviceLoadBalancerRole: aws.iam.Role | undefined;
function getServiceLoadBalancerRole(): aws.iam.Role {
    if (!serviceLoadBalancerRole) {
        let assumeRolePolicy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": "sts:AssumeRole",
                    "Principal": {
                        "Service": "ecs.amazonaws.com",
                    },
                    "Effect": "Allow",
                    "Sid": "",
                },
            ],
        };
        let policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Action": [
                        "elasticloadbalancing:DeregisterInstancesFromLoadBalancer",
                        "elasticloadbalancing:DeregisterTargets",
                        "elasticloadbalancing:Describe*",
                        "elasticloadbalancing:RegisterInstancesWithLoadBalancer",
                        "elasticloadbalancing:RegisterTargets",
                        "ec2:Describe*",
                        "ec2:AuthorizeSecurityGroupIngress",
                    ],
                    "Effect": "Allow",
                    "Resource": "*",
                },
            ],
        };
        serviceLoadBalancerRole = new aws.iam.Role("pulumi-s-lb-role", {
            assumeRolePolicy: JSON.stringify(assumeRolePolicy),
        });
        let rolePolicy = new aws.iam.RolePolicy("pulumi-s-lb-role", {
            role: serviceLoadBalancerRole.name,
            policy: JSON.stringify(policy),
        });
    }
    return serviceLoadBalancerRole;
}

let MAX_LISTENERS_PER_NLB = 50;
let loadBalancer: aws.elasticloadbalancingv2.LoadBalancer | undefined;
let listenerIndex = 0;

interface ContainerPortLoadBalancer {
    loadBalancer: aws.elasticloadbalancingv2.LoadBalancer;
    targetGroup: aws.elasticloadbalancingv2.TargetGroup;
    listenerPort: number;
}

// createLoadBalancer allocates a new Load Balancer TargetGroup that can be
// attached to a Service container and port pair. Allocates a new NLB is needed
// (currently 50 ports can be exposed on a single NLB).
function newLoadBalancerTargetGroup(container: cloud.Container, port: number): ContainerPortLoadBalancer {
    if (listenerIndex % MAX_LISTENERS_PER_NLB === 0) {
        // Create a new Load Balancer every 50 requests for a new TargetGroup.
        if (!ecsClusterSubnets) {
            throw new Error("Cannot create 'Service'. Missing cluster config 'cloud-aws:config:ecsClusterSubnets'");
        }
        let subnets = ecsClusterSubnets.split(",");
        let subnetmapping = subnets.map(s => ({ subnetId: s }));
        let lbname = `pulumi-s-lb-${listenerIndex / MAX_LISTENERS_PER_NLB + 1}`;
        loadBalancer = new aws.elasticloadbalancingv2.LoadBalancer(lbname, {
            loadBalancerType: "network",
            subnetMapping: subnetmapping,
            internal: false,
        });
    }
    if (!ecsClusterVpcId) {
        throw new Error("Cannot create 'Service'. Missing cluster config 'cloud-aws:config:ecsClusterVpcId'");
    }
    let targetListenerName = `pulumi-s-lb-${listenerIndex}`;
    // Create the target group for the new container/port pair.
    let target = new aws.elasticloadbalancingv2.TargetGroup(targetListenerName, {
        port: port,
        protocol: "TCP",
        vpcId: ecsClusterVpcId,
        deregistrationDelay: 30,
    });
    // Listen on a new port on the NLB and forward to the target.
    let listenerPort = 34567 + listenerIndex % MAX_LISTENERS_PER_NLB;
    let listener = new aws.elasticloadbalancingv2.Listener(targetListenerName, {
        loadBalancerArn: loadBalancer!.arn,
        protocol: "TCP",
        port: listenerPort,
        defaultActions: [{
            type: "forward",
            targetGroupArn: target.arn,
        }],
    });
    listenerIndex++;
    return {
        loadBalancer: loadBalancer!,
        targetGroup: target,
        listenerPort: listenerPort,
    };
}

export class Service implements cloud.Service {
    name: string;
    exposedPorts: {
        [name: string]: {
            [port: number]: {
                host: aws.elasticloadbalancingv2.LoadBalancer,
                port: number,
            },
        },
    };

    getHostAndPort: (containerName: string, containerPort: number) => Promise<string>;

    constructor(name: string, args: cloud.ServiceArguments) {
        if (!ecsClusterARN) {
            throw new Error("Cannot create 'Service'.  Missing cluster config 'cloud-aws:config:ecsClusterARN'");
        }
        let containers = args.containers;
        let scale = args.scale === undefined ? 1 : args.scale;
        this.name = name;

        // Create a single log group for all logging associated with the Service
        let logGroup = new aws.cloudwatch.LogGroup(name, {});

        // Create the task definition for the group of containers associated with this Service.
        let taskDefinition = new aws.ecs.TaskDefinition(name, {
            family: name,
            containerDefinitions: logGroup.id.then(logGroupId =>
                JSON.stringify(Object.keys(containers).map(containerName => {
                    let container = containers[containerName];
                    let containerDefinition: ECSContainerDefinition = {
                        name: containerName,
                        image: container.image,
                        command: container.command,
                        memoryReservation: container.memory,
                        portMappings: container.portMappings,
                        logConfiguration: {
                            logDriver: "awslogs",
                            options: {
                                "awslogs-group": logGroupId!,
                                "awslogs-region": "us-east-1",
                                "awslogs-stream-prefix": containerName,
                            },
                        },
                    };
                    return containerDefinition;
                })),
            ),
        });

        // Create load balancer listeners/targets for each exposed port.
        let loadBalancers = [];
        this.exposedPorts = {};
        for (let containerName of Object.keys(containers)) {
            let container = containers[containerName];
            this.exposedPorts[containerName] = {};
            if (container.portMappings) {
                for (let portMapping of container.portMappings) {
                    let info = newLoadBalancerTargetGroup(container, portMapping.containerPort);
                    this.exposedPorts[containerName][portMapping.containerPort] = {
                        host: info.loadBalancer,
                        port: info.listenerPort,
                    };
                    loadBalancers.push({
                        containerName: containerName,
                        containerPort: portMapping.containerPort,
                        targetGroupArn: info.targetGroup.arn,
                    });
                }
            }
        }

        // Create the service.
        let service = new aws.ecs.Service(name, {
            desiredCount: scale,
            taskDefinition: taskDefinition.arn,
            cluster: ecsClusterARN,
            loadBalancers: loadBalancers,
            iamRole: getServiceLoadBalancerRole().arn,
        });
        let serviceName = service.name;

        // getHostAndPort returns the host and port info for a given
        // containerName and exposed port.
        this.getHostAndPort = async function(containerName, port) {
            let containerPorts = this.exposedPorts[containerName] || {};
            let info = containerPorts[port];
            if (!info) {
                throw new Error(
                    `No exposed port for ${containerName} port ${port}`,
                );
            }
            return `${info.host.dnsName}:${info.port}`;
        };
    }

}

export class FileSystem implements cloud.FileSystem {
    constructor(name: string) {
        console.log("creating FS: " + name);
    }
}
