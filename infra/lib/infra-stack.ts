import { aws_ec2 as ec2, CfnParameter, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_eks as eks } from 'aws-cdk-lib';
import { ClusterAutoscaler } from './addons/cluster-autoscaler';
import { FluxV2 } from './addons/fluxv2';
import { AWSLoadBalancerController } from './addons/aws-lbc';
import { KubectlV28Layer } from '@aws-cdk/lambda-layer-kubectl-v28';

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const repoUrl = new CfnParameter(this, 'FluxRepoURL', {
      type: 'String',
      description: "The URL to the git repository to use for Flux"
    });
    const repoBranch = new CfnParameter(this, 'FluxRepoBranch', {
      type: 'String',
      description: "Branch to use from the repository",
      default: "main"
    });
    const repoPath = new CfnParameter(this, 'FluxRepoPath', {
      type: 'String',
      description: 'Which path to start the sync from'
    });

    // A VPC, including NAT GWs, IGWs, where we will run our cluster
    const vpc = new ec2.Vpc(this, 'GREEN', {
      natGateways: 0,
      maxAzs: 2,
      // enableDnsHostnames: true,
      // enableDnsSupport: true,
      // deprecated: cidr: '172.0.0.0/26',
      ipAddresses: ec2.IpAddresses.cidr('172.0.0.0/26'),
      subnetConfiguration: [
        {
          name: 'PUBLIC',
          subnetType: ec2.SubnetType.PUBLIC
        },
        {
          name: 'PRIVATE_WITH_EGRESS',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ]
    });

    // The IAM role that will be used by EKS
    const clusterRole = new iam.Role(this, 'ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController')
      ]
    });

    // The EKS cluster, without worker nodes as we'll add them later
    const cluster = new eks.Cluster(this, 'Cluster', {
      vpc: vpc,
      role: clusterRole,
      version: eks.KubernetesVersion.V1_28,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV28Layer(this, 'kubectl'),
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE        // SHOULD BE SET TO PRIVATE !!
    });

    // Worker node IAM role
    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController') // Allows us to use Security Groups for pods
      ]
    });

    // Select the private subnets created in our VPC and place our worker nodes there
    //const isolatedSubnets = vpc.selectSubnets({
    //  subnetType: ec2.SubnetType.PRIVATE_ISOLATED
    //});

    cluster.addNodegroupCapacity('WorkerNodeGroup', {
      nodeRole: workerRole,
      minSize: 1,
      maxSize: 2
    });

    // Add our default addons
    new ClusterAutoscaler(this, 'ClusterAutoscaler', {
      cluster: cluster
    });

    // Add FluxV2
    new FluxV2(this, 'FluxV2', {
      cluster: cluster,
      secretName: 'github-keypair',
      repoUrl: repoUrl.valueAsString,
      repoBranch: repoBranch.valueAsString,
      repoPath: repoPath.valueAsString
    });

    // Add AWS Load Balancer Controller
    new AWSLoadBalancerController(this, 'AWSLoadBalancerController', {
      cluster: cluster,
      namespace: 'kube-system'
    });
  }
}
