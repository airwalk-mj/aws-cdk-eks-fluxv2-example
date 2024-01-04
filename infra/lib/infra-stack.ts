import { aws_ec2 as ec2, CfnParameter, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { aws_iam as iam } from 'aws-cdk-lib';
import { aws_eks as eks } from 'aws-cdk-lib';
import { ClusterAutoscaler } from './addons/cluster-autoscaler';
import { FluxV2 } from './addons/fluxv2';
import { AWSLoadBalancerController } from './addons/aws-lbc';
import { KubectlV27Layer } from '@aws-cdk/lambda-layer-kubectl-v27';
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
    const vpc = new ec2.Vpc(this, 'GREEN-VPC', {
      natGateways: 1,
      maxAzs: 2,
      enableDnsHostnames: true,       // required by private EKS endpoint
      enableDnsSupport: true,         // required by private EKS endpoint
      // deprecated: cidr: '172.0.0.0/26',
      ipAddresses: ec2.IpAddresses.cidr('172.0.0.0/26'),
      subnetConfiguration: [
        {
          name: 'GREEN-PUBLIC',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: 'GREEN-PRIVATE_WITH_EGRESS',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
        }
      ],
      gatewayEndpoints: {
        S3: {
          service: ec2.GatewayVpcEndpointAwsService.S3,     
        },
      },
    });
    
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ec2.InterfaceVpcEndpointOptions.html
    new ec2.InterfaceVpcEndpoint(this, 'ec2.endpoint', {           
      vpc,
      service: new ec2.InterfaceVpcEndpointService('com.amazonaws.eu-west-1.ec2', 443),
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    new ec2.InterfaceVpcEndpoint(this, 'ecr-endpoint', {
      vpc,
      service: new ec2.InterfaceVpcEndpointService('com.amazonaws.eu-west-1.ecr.api', 443),
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    new ec2.InterfaceVpcEndpoint(this, 'eks-endpoint', {
      vpc,
      service: new ec2.InterfaceVpcEndpointService('com.amazonaws.eu-west-1.eks', 443),
      subnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      }
    });

    // The IAM role that will be used by EKS
    const clusterRole = new iam.Role(this, 'GREEN-ClusterRole', {
      assumedBy: new iam.ServicePrincipal('eks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSClusterPolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController')
      ]
    });

    // The EKS cluster, without worker nodes as we'll add them later
    const cluster = new eks.Cluster(this, 'GREEN-Cluster', {
      vpc: vpc,
      role: clusterRole,
      version: eks.KubernetesVersion.V1_27,
      defaultCapacity: 0,
      kubectlLayer: new KubectlV27Layer(this, 'kubectl'),
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE        // SHOULD BE SET TO PRIVATE AND ACCESSED VIA VPC TGW !
    });

    // Worker node IAM role
    const workerRole = new iam.Role(this, 'GREEN-WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSVPCResourceController') // Allows us to use Security Groups for pods
      ]
    });

    // Select the private subnets created in our VPC and place our worker nodes there
    const privateSubnets = vpc.selectSubnets({
      // subnetType: ec2.SubnetType.PRIVATE_WITH_NAT   // DEPRECATED
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
    }); 

    cluster.addNodegroupCapacity('GREEN-WorkerNodeGroup', {
      subnets: privateSubnets,
      nodeRole: workerRole,
      minSize: 1,
      maxSize: 2,
      //amiType: eks.NodegroupAmiType.AL2_ARM_64,
      amiType: eks.NodegroupAmiType.BOTTLEROCKET_ARM_64
    });

    // Add our default addons
    new ClusterAutoscaler(this, 'GREEN-ClusterAutoscaler', {
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
