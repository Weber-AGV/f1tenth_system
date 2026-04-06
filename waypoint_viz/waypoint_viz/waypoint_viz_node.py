import csv
import math
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSDurabilityPolicy, QoSReliabilityPolicy, QoSHistoryPolicy
from nav_msgs.msg import Odometry, Path
from geometry_msgs.msg import PoseStamped
from visualization_msgs.msg import Marker, MarkerArray
from std_msgs.msg import ColorRGBA


class WaypointVizNode(Node):
    def __init__(self):
        super().__init__('waypoint_viz_node')

        self.declare_parameter('waypoint_file', 'waypoints.csv')
        self.declare_parameter('lookahead_distance', 1.5)
        self.declare_parameter('waypoint_frame', 'map')

        waypoint_file = self.get_parameter('waypoint_file').get_parameter_value().string_value
        self.lookahead_distance = self.get_parameter('lookahead_distance').get_parameter_value().double_value
        self.frame = self.get_parameter('waypoint_frame').get_parameter_value().string_value

        self.waypoints = self._load_waypoints(waypoint_file)
        if not self.waypoints:
            self.get_logger().error(f'No waypoints loaded from {waypoint_file}')
            return

        self.get_logger().info(f'Loaded {len(self.waypoints)} waypoints from {waypoint_file}')

        latched_qos = QoSProfile(
            depth=1,
            durability=QoSDurabilityPolicy.TRANSIENT_LOCAL,
            reliability=QoSReliabilityPolicy.RELIABLE,
            history=QoSHistoryPolicy.KEEP_LAST,
        )
        best_effort_qos = QoSProfile(
            depth=1,
            durability=QoSDurabilityPolicy.VOLATILE,
            reliability=QoSReliabilityPolicy.BEST_EFFORT,
            history=QoSHistoryPolicy.KEEP_LAST,
        )

        self.waypoints_pub = self.create_publisher(MarkerArray, '/waypoint_viz/waypoints', latched_qos)
        self.path_pub = self.create_publisher(Path, '/waypoint_viz/path', latched_qos)
        self.lookahead_pub = self.create_publisher(Marker, '/waypoint_viz/lookahead', best_effort_qos)

        self.create_subscription(Odometry, '/pf/pose/odom', self._pose_cb, 10)

        self._publish_waypoints()
        self._publish_path()

    def _load_waypoints(self, filepath):
        waypoints = []
        try:
            with open(filepath, 'r') as f:
                reader = csv.reader(f)
                for row in reader:
                    if len(row) < 4:
                        continue
                    try:
                        x, y, z, w = float(row[0]), float(row[1]), float(row[2]), float(row[3])
                        waypoints.append((x, y, z, w))
                    except ValueError:
                        continue  # skip header or malformed lines
        except FileNotFoundError:
            self.get_logger().error(f'Waypoint file not found: {filepath}')
        return waypoints

    def _publish_waypoints(self):
        marker_array = MarkerArray()
        for i, (x, y, z, w) in enumerate(self.waypoints):
            m = Marker()
            m.header.frame_id = self.frame
            m.header.stamp = self.get_clock().now().to_msg()
            m.ns = 'waypoints'
            m.id = i
            m.type = Marker.SPHERE
            m.action = Marker.ADD
            m.pose.position.x = x
            m.pose.position.y = y
            m.pose.position.z = 0.0
            m.pose.orientation.w = 1.0
            m.scale.x = 0.1
            m.scale.y = 0.1
            m.scale.z = 0.1
            m.color = ColorRGBA(r=1.0, g=1.0, b=0.0, a=1.0)  # yellow
            marker_array.markers.append(m)
        self.waypoints_pub.publish(marker_array)

    def _publish_path(self):
        path = Path()
        path.header.frame_id = self.frame
        path.header.stamp = self.get_clock().now().to_msg()
        for x, y, z, w in self.waypoints:
            ps = PoseStamped()
            ps.header.frame_id = self.frame
            ps.pose.position.x = x
            ps.pose.position.y = y
            ps.pose.position.z = 0.0
            ps.pose.orientation.z = z
            ps.pose.orientation.w = w
            path.poses.append(ps)
        self.path_pub.publish(path)

    def _pose_cb(self, msg):
        cx = msg.pose.pose.position.x
        cy = msg.pose.pose.position.y

        # find nearest waypoint index
        min_dist = float('inf')
        nearest = 0
        for i, (x, y, _, _) in enumerate(self.waypoints):
            d = math.hypot(x - cx, y - cy)
            if d < min_dist:
                min_dist = d
                nearest = i

        # walk forward from nearest until lookahead distance is reached
        n = len(self.waypoints)
        lookahead_x, lookahead_y = self.waypoints[nearest][0], self.waypoints[nearest][1]
        for offset in range(n):
            idx = (nearest + offset) % n
            wx, wy = self.waypoints[idx][0], self.waypoints[idx][1]
            if math.hypot(wx - cx, wy - cy) >= self.lookahead_distance:
                lookahead_x, lookahead_y = wx, wy
                break

        m = Marker()
        m.header.frame_id = self.frame
        m.header.stamp = self.get_clock().now().to_msg()
        m.ns = 'lookahead'
        m.id = 0
        m.type = Marker.SPHERE
        m.action = Marker.ADD
        m.pose.position.x = lookahead_x
        m.pose.position.y = lookahead_y
        m.pose.position.z = 0.05
        m.pose.orientation.w = 1.0
        m.scale.x = 0.2
        m.scale.y = 0.2
        m.scale.z = 0.2
        m.color = ColorRGBA(r=0.0, g=1.0, b=0.0, a=1.0)  # green
        self.lookahead_pub.publish(m)


def main(args=None):
    rclpy.init(args=args)
    node = WaypointVizNode()
    rclpy.spin(node)
    rclpy.shutdown()


if __name__ == '__main__':
    main()
