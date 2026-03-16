# MIT License

# Copyright (c) 2025 WSU F1TENTH

# Converts nav2 cmd_vel (geometry_msgs/Twist) to AckermannDriveStamped
# so that nav2 navigation commands reach the ackermann_mux → VESC pipeline.
#
# Topic mapping:
#   subscribes: /cmd_vel  (geometry_msgs/Twist)
#   publishes:  /drive    (ackermann_msgs/AckermannDriveStamped)
#
# Conversion:
#   speed          = twist.linear.x
#   steering_angle = atan(wheelbase * twist.angular.z / twist.linear.x)

import math
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from ackermann_msgs.msg import AckermannDriveStamped


class CmdVelToAckermann(Node):
    def __init__(self):
        super().__init__('cmd_vel_to_ackermann')
        self.declare_parameter('wheelbase', 0.25)  # meters — matches vesc.yaml
        self.wheelbase = self.get_parameter('wheelbase').value

        self.pub = self.create_publisher(AckermannDriveStamped, 'drive', 10)
        self.sub = self.create_subscription(Twist, 'cmd_vel', self._callback, 10)

    def _callback(self, msg):
        ackermann_msg = AckermannDriveStamped()
        ackermann_msg.header.stamp = self.get_clock().now().to_msg()
        ackermann_msg.header.frame_id = 'base_link'
        ackermann_msg.drive.speed = msg.linear.x

        if abs(msg.linear.x) > 0.001:
            ackermann_msg.drive.steering_angle = math.atan(
                self.wheelbase * msg.angular.z / msg.linear.x
            )
        else:
            # At (near) zero speed, Ackermann steering angle is undefined;
            # output zero to hold wheels straight.
            ackermann_msg.drive.steering_angle = 0.0

        self.pub.publish(ackermann_msg)


def main(args=None):
    rclpy.init(args=args)
    node = CmdVelToAckermann()
    rclpy.spin(node)


if __name__ == '__main__':
    main()
